import './party.css';
import type { PartyView, SpaceView, WorldLink } from '../../net/worldLink';
import { COMBAT } from '../../tuning';
import type { LifePress } from '../life/lifeUI';
import { closeMenu, openMenu, type MenuEntry } from '../theme/contextMenu';
import { uiIcon } from '../theme/icons';
import { uiRoot } from '../theme/scale';

// Parties, online (server/src/parties.rs): a few players who play together, as groups do in World
// of Warcraft, and go into a dungeon's copy together (server/src/spaces.rs). The party frame under
// your portrait shows everyone else in it (health while they're near you, where they are when
// they're not); the Party window (O) invites someone, by name or from the players near you, and is
// where the leader hands on the lead or removes someone, and anyone leaves. An invitation asks in a
// window of its own. Right-click a member for what you can do with them. Everything here is what the
// server says: the windows show it and send what you choose. Offline there's nobody to party with.

export interface PartyDeps {
  link: WorldLink;
  /** Your own character. */
  me: number;
  /** Which of the island's windows is open, if any (one docked on the left covers the frame). */
  openPanel: () => string | null;
  /** The pointer is the camera's: let go of it, to use a window. */
  freeMouse: () => void;
  /** Other players near you now, nearest first, with how far they are (m). */
  nearby: () => Array<{ id: number; name: string; dist: number }>;
}

/** The island's windows that dock on the left, where the party frame is. */
const LEFT_PANELS = new Set(['dialog', 'shop', 'craft', 'storage', 'log', 'character', 'garage', 'settings', 'dev', 'map']);
/** Players this near are listed to invite. */
const NEAR = 40;

const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function el(cls: string, id: string): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  e.id = id;
  e.hidden = true;
  return e;
}

/** Where someone is, as a tag: a dungeon's name, or their channel. */
function placeTag(p: SpaceView | null): string {
  if (!p) return 'Offline';
  return p.kind === 'dungeon' ? p.name : `Emberholm ${p.channel}`;
}

/** Seconds as "28m" or "45s". */
function shortTime(s: number): string {
  return s >= 60 ? `${Math.ceil(s / 60)}m` : `${Math.max(0, Math.ceil(s))}s`;
}

export class PartyUI {
  private frame = el('party-frame', 'hud-party');
  private invite = el('mw party-win party-invite', 'party-invite');
  private win = el('mw left party-win', 'party-win');
  private sig = { frame: '', invite: '', win: '' };
  /** What's typed in the window's name field, kept while it redraws. */
  private name = '';

  constructor(private d: PartyDeps) {
    for (const w of [this.frame, this.invite, this.win]) {
      w.addEventListener('click', (e) => this.onClick(e));
      w.addEventListener('contextmenu', (e) => this.onMenu(e));
      uiRoot().append(w);
    }
    // Typing a name: the keys are the field's, not the game's.
    this.win.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName !== 'INPUT') return;
      e.stopPropagation();
      if (e.key === 'Enter') this.inviteByName();
      if (e.key === 'Escape') (t as HTMLInputElement).blur();
    });
    this.win.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.field === 'name') this.name = t.value;
    });
    d.link.onParty = () => this.render(true);
    d.link.onInvite = () => this.render(true);
    this.render(true);
  }

  get windowOpen(): boolean {
    return !this.win.hidden;
  }

  /** An invitation is asking, or the Party window is open: on a controller it has the pad. */
  get takesPad(): boolean {
    return !this.invite.hidden || !this.win.hidden;
  }

  /** The highlighted button in the Party window, for a controller (-1: none). */
  private focus = -1;

  /**
   * Menu presses (D-pad, stick, A / B, arrow keys): an invitation takes A to accept and B to
   * decline; the Party window moves the highlight over its buttons, presses it with A, and closes
   * with B. False when neither is showing.
   */
  menu(m: string): boolean {
    const inv = this.d.link.invite;
    if (inv && !this.invite.hidden) {
      if (m === 'select') this.d.link.partyAnswer(inv.from, true);
      else if (m === 'back') this.d.link.partyAnswer(inv.from, false);
      return true;
    }
    if (this.win.hidden) return false;
    if (m === 'back') {
      this.close();
      return true;
    }
    const buttons = [...this.win.querySelectorAll<HTMLElement>('[data-act]:not([disabled]):not(.mw-x)')];
    if (!buttons.length) return true;
    if (m === 'up' || m === 'left') this.focus = this.focus <= 0 ? buttons.length - 1 : this.focus - 1;
    else if (m === 'down' || m === 'right') this.focus = (this.focus + 1) % buttons.length;
    else if (m === 'select' && this.focus >= 0) buttons[Math.min(this.focus, buttons.length - 1)].click();
    buttons.forEach((b, i) => b.classList.toggle('lui-focus', i === this.focus));
    return true;
  }

  /** A key, before the island's windows see it: O opens and shuts the Party window; Escape declines an invitation, then closes the window. */
  intercept(k: LifePress): boolean {
    if (k === 'party') {
      this.toggle();
      return true;
    }
    if (k === 'escape') {
      const inv = this.d.link.invite;
      if (inv) {
        this.d.link.partyAnswer(inv.from, false);
        return true;
      }
      if (!this.win.hidden) {
        this.close();
        return true;
      }
    }
    return false;
  }

  toggle(): void {
    if (this.win.hidden) this.open();
    else this.close();
  }

  open(): void {
    this.win.hidden = false;
    this.focus = -1;
    this.d.freeMouse();
    this.render(true);
  }

  close(): void {
    this.win.hidden = true;
    closeMenu();
    this.render(true);
  }

  /** Every frame: health bars and countdowns move; the rest redraws when the server says something. */
  update(): void {
    this.render(false);
  }

  private party(): PartyView | null {
    return this.d.link.party;
  }

  private others(): PartyView['members'] {
    return this.party()?.members.filter((m) => m.id !== this.d.me) ?? [];
  }

  private leads(): boolean {
    return this.party()?.leader === this.d.me;
  }

  /** Someone's health (0..1) if they're near enough to be seen, else null. */
  private hp(id: number): number | null {
    const peer = this.d.link.peers.get(id);
    const hp = peer?.p.hp;
    return typeof hp === 'number' ? Math.max(0, Math.min(1, hp / COMBAT.maxHp)) : null;
  }

  /** The party's copy of a dungeon, as a line: how many are inside, or when it closes. */
  private dungeonLine(p: PartyView): string {
    const d = p.dungeons[0];
    if (!d) return '';
    if (d.closesIn === null) return `${d.name}: ${d.inside} inside`;
    const left = d.closesIn - (performance.now() - this.d.link.partyHeard) / 1000;
    return `${d.name}: kept ${shortTime(left)} more`;
  }

  render(force: boolean): void {
    this.renderFrame(force);
    this.renderInvite(force);
    this.renderWindow(force);
  }

  private renderFrame(force: boolean): void {
    const p = this.party();
    const covered = LEFT_PANELS.has(this.d.openPanel() ?? '') || !this.win.hidden;
    if (!p || covered) {
      this.frame.hidden = true;
      return;
    }
    const rows = this.others().map((m) => {
      const hp = this.hp(m.id);
      return { m, hp: hp === null ? null : Math.round(hp * 100) };
    });
    const line = this.dungeonLine(p);
    const sig = JSON.stringify([p, rows.map((r) => r.hp), line]);
    if (!force && sig === this.sig.frame && !this.frame.hidden) return;
    this.sig.frame = sig;
    this.frame.innerHTML =
      `<div class="pf-head" data-act="window" title="Party (O)">${uiIcon('party', 20)}<span>Party</span><small>${p.members.length}</small></div>` +
      rows
        .map(({ m, hp }) => {
          const crown = m.id === p.leader ? `<i class="crown" title="Leader">${uiIcon('crown', 14)}</i>` : '';
          const away = !m.online ? ' off' : hp === null ? ' far' : '';
          const bar = hp === null ? `<span class="tag">${esc(placeTag(m.place))}</span>` : `<span class="bar"><i style="width:${hp}%"></i></span>`;
          return `<div class="pf-row${away}" data-member="${m.id}">${crown}<b>${esc(m.name)}</b>${bar}</div>`;
        })
        .join('') +
      (line ? `<div class="pf-dungeon">${esc(line)}</div>` : '');
    this.frame.hidden = false;
  }

  private renderInvite(force: boolean): void {
    const inv = this.d.link.invite;
    if (!inv) {
      if (!this.invite.hidden) {
        this.invite.hidden = true;
        this.invite.innerHTML = '';
        this.sig.invite = '';
      }
      return;
    }
    const left = Math.max(0, inv.ms - (performance.now() - this.d.link.inviteHeard));
    const sig = `${inv.from}|${Math.ceil(left / 1000)}`;
    if (!force && sig === this.sig.invite && !this.invite.hidden) return;
    const fresh = this.invite.hidden;
    this.sig.invite = sig;
    this.invite.innerHTML =
      `<div class="mw-bar">Party Invitation</div><div class="mw-x" data-act="decline" title="Decline (Esc)">✕</div>` +
      `<div class="mw-body"><p class="pi-say"><b>${esc(inv.name)}</b> invites you to join their party.</p>` +
      `<p class="note">You'll go into dungeons together, each party in a copy of its own.</p>` +
      `<div class="pi-time"><i style="width:${Math.round((left / 60000) * 100)}%"></i></div></div>` +
      `<div class="mw-foot"><button class="lui-btn" data-act="decline">Decline</button><button class="lui-btn gold" data-act="accept">Accept</button></div>`;
    this.invite.hidden = false;
    if (fresh) this.d.freeMouse();
  }

  private renderWindow(force: boolean): void {
    if (this.win.hidden) return;
    const p = this.party();
    const leads = !p || this.leads();
    const full = !!p && p.members.length >= 5;
    const inParty = new Set(p?.members.map((m) => m.id) ?? []);
    const around = this.d.nearby().filter((n) => n.dist <= NEAR);
    const near = around.filter((n) => !inParty.has(n.id)).slice(0, 6);
    const sig = JSON.stringify([p, near.map((n) => [n.id, Math.round(n.dist)]), leads, this.dungeonLine(p ?? { id: 0, leader: 0, members: [], dungeons: [] })]);
    if (!force && sig === this.sig.win) return;
    this.sig.win = sig;
    const focused = document.activeElement instanceof HTMLInputElement && this.win.contains(document.activeElement);
    const members = p
      ? p.members
          .map((m) => {
            const you = m.id === this.d.me;
            const crown = m.id === p.leader ? `<i class="crown" title="Leader">${uiIcon('crown', 16)}</i>` : '';
            return `<div class="lui-row pw-member" data-member="${m.id}">${crown}<b>${esc(m.name)}${you ? ' <small>(You)</small>' : ''}</b><span class="tag">${esc(placeTag(m.online ? m.place : null))}</span></div>`;
          })
          .join('')
      : `<p class="muted">You aren't in a party. Invite someone to start one: you'll lead it.</p>`;
    const dungeon = p ? this.dungeonLine(p) : '';
    const why = !leads ? 'Only the party leader can invite.' : full ? 'Your party is full.' : '';
    const nearRows = near.length
      ? near
          .map(
            (n) =>
              `<div class="lui-row pw-near" data-near="${n.id}"><b>${esc(n.name)}</b><span class="tag">${Math.round(n.dist)} m</span>` +
              `<button class="lui-btn small" data-act="invite" data-arg="${n.id}"${why ? ` disabled title="${esc(why)}"` : ''}>Invite</button></div>`,
          )
          .join('')
      : `<p class="muted">${around.length ? 'Nobody else is near you.' : 'Nobody is near you.'}</p>`;
    this.win.innerHTML =
      `<div class="mw-bar">Party${p ? ` <small>${p.members.length} of 5</small>` : ''}</div><div class="mw-x" data-act="close" title="Close (Esc)">✕</div>` +
      `<div class="mw-body">` +
      `<h3>Members</h3>${members}` +
      (dungeon ? `<p class="note pw-dungeon">${esc(dungeon)}</p>` : '') +
      `<h3>Invite by Name</h3><div class="pw-name"><input type="text" data-field="name" maxlength="24" placeholder="Their character's name" value="${esc(this.name)}"${why ? ' disabled' : ''}>` +
      `<button class="lui-btn gold" data-act="inviteName"${why ? ' disabled' : ''}>Invite</button></div>` +
      (why ? `<p class="note">${esc(why)}</p>` : '') +
      `<h3>Players Nearby</h3>${nearRows}` +
      `</div>` +
      `<div class="mw-foot"><span class="note">Right-click a member for more.</span>` +
      (p ? `<button class="lui-btn" data-act="leave">Leave Party</button>` : '') +
      `</div>`;
    if (focused) {
      const input = this.win.querySelector('input[data-field="name"]') as HTMLInputElement | null;
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  private inviteByName(): void {
    const name = this.name.trim();
    if (!name) return;
    if (this.d.link.partyInvite({ name })) {
      this.name = '';
      this.render(true);
    }
  }

  private onClick(e: MouseEvent): void {
    const b = (e.target as Element).closest('[data-act]') as HTMLElement | null;
    if (!b || b.hasAttribute('disabled')) return;
    e.stopPropagation();
    const link = this.d.link;
    const act = b.dataset.act!;
    if (act === 'window') this.toggle();
    else if (act === 'close') this.close();
    else if (act === 'accept' || act === 'decline') {
      const inv = link.invite;
      if (inv) link.partyAnswer(inv.from, act === 'accept');
    } else if (act === 'invite') link.partyInvite({ to: Number(b.dataset.arg) });
    else if (act === 'inviteName') this.inviteByName();
    else if (act === 'leave') this.leaveAsked(b);
  }

  /** Leaving asks once more (design/ui.html: giving something up asks first). */
  private leaveAsked(b: HTMLElement): void {
    if (b.dataset.sure) {
      this.d.link.partyLeave();
      return;
    }
    b.dataset.sure = '1';
    b.textContent = 'Leave the Party?';
  }

  /** What you can do with a member: right-click their row. */
  private onMenu(e: MouseEvent): void {
    const row = (e.target as Element).closest('[data-member]') as HTMLElement | null;
    e.preventDefault();
    if (!row) return;
    const p = this.party();
    if (!p) return;
    const id = Number(row.dataset.member);
    const m = p.members.find((x) => x.id === id);
    if (!m) return;
    const link = this.d.link;
    const leads = this.leads();
    const entries: MenuEntry[] =
      id === this.d.me
        ? [{ label: 'Leave Party', primary: true, run: () => link.partyLeave() }]
        : [
            { label: 'Promote to Leader', primary: true, run: () => link.partyLead(id), disabled: leads ? undefined : 'Only the leader can' },
            { label: 'Remove from Party', run: () => link.partyKick(id), disabled: leads ? undefined : 'Only the leader can' },
          ];
    openMenu(e.clientX, e.clientY, m.name, entries);
  }

  // ---------- For tests ----------

  state() {
    return {
      party: this.d.link.party,
      invite: this.d.link.invite,
      windows: { frame: !this.frame.hidden, invite: !this.invite.hidden, window: !this.win.hidden },
      frameRows: [...this.frame.querySelectorAll('[data-member]')].map((r) => (r as HTMLElement).innerText),
    };
  }
}
