import './channels.css';
import { CHANNELS } from '../../content/channels';
import type { LifePress } from '../life/lifeUI';
import { uiIcon } from '../theme/icons';
import { uiRoot } from '../theme/scale';
import { esc } from '../../util/html';

// Channels, online (crates/channels, docs/world.md): each region is played as channels, copies of it
// for crowds, with the same land in every one. The server places you in one as you arrive; another
// opens when a region fills, and a quiet one merges into another, its players moved across. The
// Channels window lists your region's channels (how busy each is, where your party and friends
// play) and asks the server to move you to one, or to your party's; the server's rules say whether
// you may (not with a pack, not in combat, not more than once in a while), and the window says why
// not. A notice at the top of the screen counts down while your channel is closing, and says where
// a move took you. Everything here is what the server says; offline there are no channels.

/** How busy a channel is (crates/channels/src/region.rs Load). */
export type ChannelLoad = 'quiet' | 'lively' | 'busy' | 'full';

/** One of a region's channels, as you see it. */
export interface ChannelRowView {
  n: number;
  load: ChannelLoad;
  /** Merging into another: nobody new goes in. */
  closing: boolean;
  /** How many of your party, and of your friends, play in it. */
  party: number;
  friends: number;
}

/** Your region's channels as the server sends them (crates/channels/src/region.rs ChannelsView). */
export interface ChannelsView {
  /** The region's id. */
  region: string;
  /** Your channel (0: you aren't in one of the region's, in a dungeon say). */
  here: number;
  list: ChannelRowView[];
  /** Your channel is merging into another: which, and how long (ms) until you're moved, as it was sent. */
  closing: { into: number; ms: number } | null;
  /** How long (ms, as it was sent) until you may change channel again, if you changed lately. */
  wait: number | null;
  /** What stops you changing channel as you stand (a pack, a fight...), if anything: a sentence. The wait since your last change is `wait`. */
  blocked: string | null;
  /** Your party's channel, if it isn't yours. */
  party: number | null;
  /** Whether you're waiting to join your party there (you'll go once the rules allow). */
  following: boolean;
}

/** The server moved you to another channel: from where, to where, and why. */
export interface ChannelMoved {
  from: number;
  to: number;
  why: 'choice' | 'party' | 'merge';
}

/**
 * What the Channels window reads of the world connection and asks of it. The app hands it the
 * connection (src/net/worldLink.ts), which the window doesn't import.
 */
export interface ChannelLink {
  /** Your region's channels as last heard (null until asked), and when they came (performance.now()). */
  readonly channels: ChannelsView | null;
  readonly channelsHeard: number;
  onChannels: ((c: ChannelsView | null) => void) | null;
  /** The last move between channels the server made, and when it was heard. */
  readonly moved: ChannelMoved | null;
  readonly movedHeard: number;
  onMoved: ((m: ChannelMoved) => void) | null;
  /** Asks for your region's channels as they are now. */
  askChannels(): boolean;
  /** Asks to go to channel `n`, or to your party's. */
  changeChannel(to: number | 'party'): boolean;
}

export interface ChannelsDeps {
  link: ChannelLink;
  /** A region's name, from its id. */
  regionName: (id: string) => string;
  /** The pointer is the camera's: let go of it, to use a window. */
  freeMouse: () => void;
  /** The window opened: another docked where it docks closes (the Party window). */
  onOpen?: () => void;
}

/** While the window is open, the channels are asked for again this often (ms). */
const REFRESH = 2000;
/** A move's notice shows this long (ms). */
const MOVED_FOR = 8000;

/** A channel's name. */
export const channelName = (n: number): string => `Channel ${n}`;

/** A wait as "3m 20s", "4m" or "45s" (rounded up to the second), as the server writes them. */
export function shortWait(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  if (m === 0) return `${s}s`;
  return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
}

/** How busy a channel is, as its tag says. */
export function loadTag(c: Pick<ChannelRowView, 'load' | 'closing'>): string {
  if (c.closing) return 'Closing';
  return { quiet: 'Quiet', lively: 'Lively', busy: 'Busy', full: 'Full' }[c.load];
}

/** The rules for changing channel, as a sentence (its numbers the content's). */
export function rulesLine(): string {
  const every = CHANNELS.changeEvery;
  const often = every % 60 === 0 ? `${every / 60} minute${every === 60 ? '' : 's'}` : `${every} seconds`;
  return `You can change channel once every ${often}, but not while carrying a pack or in combat.`;
}

/** Your channel is closing: where you'll go, and in how long (`ms` left now). */
export function closingLine(into: number, ms: number): string {
  return ms > 0
    ? `This channel is closing: you'll be moved to ${channelName(into)} in ${shortWait(ms)}.`
    : `This channel is closing: you'll be moved to ${channelName(into)} in a moment.`;
}

/** Where a move took you. */
export function movedLine(m: ChannelMoved): string {
  if (m.why === 'merge') return `${channelName(m.from)} has closed: you're in ${channelName(m.to)} now.`;
  if (m.why === 'party') return `You've joined your party in ${channelName(m.to)}.`;
  return `You're in ${channelName(m.to)} now.`;
}

/** What stops you changing channel now, if anything: what the server says stops you as you stand, else the wait left (`waitLeft`, ms) since your last change. */
export function stoppedBy(v: ChannelsView, waitLeft: number): string | null {
  return v.blocked ?? (waitLeft > 0 ? `You can change channel again in ${shortWait(waitLeft)}.` : null);
}

/** One channel as the window lists it: its name and tags, and whether (and why not) you can go to it. */
export interface ChannelLine {
  n: number;
  name: string;
  tags: string[];
  here: boolean;
  /** Why you can't go there, if you can't (null: you can, or you're there). */
  why: string | null;
}

/** The window's lines for a view, `waitLeft` ms before you may change again: every channel, yours marked, and why you can't go to each. */
export function channelLines(v: ChannelsView, waitLeft: number): ChannelLine[] {
  const stopped = stoppedBy(v, waitLeft);
  return v.list.map((c) => {
    const here = c.n === v.here;
    const friends = c.friends === 1 ? '1 Friend' : c.friends ? `${c.friends} Friends` : '';
    const tags = [here ? "You're Here" : '', loadTag(c), c.party ? 'Your Party' : '', friends].filter(Boolean);
    const why = here ? null : c.closing ? 'That channel is closing.' : c.load === 'full' ? 'That channel is full.' : stopped;
    return { n: c.n, name: channelName(c.n), tags, here, why };
  });
}

function el(cls: string, id: string): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  e.id = id;
  e.hidden = true;
  return e;
}

export class ChannelsUI {
  private win = el('mw left channels-win', 'channels-win');
  private notice = el('ch-notice', 'hud-channel');
  private sig = { win: '', notice: '' };
  private asked = 0;
  /** The highlighted button in the window, for a controller (-1: none). */
  private focus = -1;

  constructor(private d: ChannelsDeps) {
    this.win.addEventListener('click', (e) => this.onClick(e));
    uiRoot().append(this.win, this.notice);
    // Moved, or into a dungeon: what was heard of the channels was of the old place; the open
    // window asks again at once.
    d.link.onChannels = (c) => {
      if (!c && !this.win.hidden) this.ask();
      this.render(true);
    };
    d.link.onMoved = () => this.render(true);
    this.render(true);
  }

  get windowOpen(): boolean {
    return !this.win.hidden;
  }

  /** The window is open: on a controller it has the pad. */
  get takesPad(): boolean {
    return !this.win.hidden;
  }

  toggle(): void {
    if (this.win.hidden) this.open();
    else this.close();
  }

  open(): void {
    this.win.hidden = false;
    this.focus = -1;
    this.d.onOpen?.();
    this.d.freeMouse();
    this.ask();
    this.render(true);
  }

  close(): void {
    this.win.hidden = true;
    this.render(true);
  }

  /** A key, before the life's windows see it: the Channels button opens and shuts the window; Escape closes it. */
  intercept(k: LifePress): boolean {
    if (k === 'channels') {
      this.toggle();
      return true;
    }
    if (k === 'escape' && !this.win.hidden) {
      this.close();
      return true;
    }
    return false;
  }

  /** Menu presses (D-pad, stick, A / B, arrow keys): the highlight moves over the buttons, A presses, B closes. False while it's shut. */
  menu(m: string): boolean {
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

  /** Every frame: countdowns move, and the open window asks the server again now and then. */
  update(): void {
    if (!this.win.hidden && performance.now() - this.asked > REFRESH) this.ask();
    this.render(false);
  }

  private ask(): void {
    this.asked = performance.now();
    this.d.link.askChannels();
  }

  /** Time left (ms) on something the server said `ms` of, `heard` ago. */
  private left(ms: number, heard: number): number {
    return ms - (performance.now() - heard);
  }

  render(force: boolean): void {
    this.renderNotice(force);
    this.renderWindow(force);
  }

  private renderNotice(force: boolean): void {
    const { channels: v, channelsHeard, moved, movedHeard } = this.d.link;
    // A move heard since the channels were is news; else a closing channel's countdown; else a move a moment ago.
    const recent = !!moved && performance.now() - movedHeard < MOVED_FOR;
    let text = '';
    if (moved && recent && movedHeard >= channelsHeard) text = movedLine(moved);
    else if (v?.closing) text = closingLine(v.closing.into, this.left(v.closing.ms, channelsHeard));
    else if (moved && recent) text = movedLine(moved);
    if (!force && text === this.sig.notice) return;
    this.sig.notice = text;
    this.notice.hidden = !text;
    this.notice.innerHTML = text ? `${uiIcon('portal', 22)}<p>${esc(text)}</p>` : '';
  }

  private renderWindow(force: boolean): void {
    if (this.win.hidden) return;
    const v = this.d.link.channels;
    const heard = this.d.link.channelsHeard;
    const wait = v?.wait ? Math.max(0, this.left(v.wait, heard)) : 0;
    const closing = v?.closing ? closingLine(v.closing.into, this.left(v.closing.ms, heard)) : '';
    const sig = JSON.stringify([v, Math.ceil(wait / 1000), closing]);
    if (!force && sig === this.sig.win) return;
    this.sig.win = sig;
    const region = v ? this.d.regionName(v.region) : '';
    const stopped = v ? stoppedBy(v, wait) : null;
    let body: string;
    if (!v) body = `<p class="muted">Asking the server…</p>`;
    else if (!v.here) body = `<p class="muted">You aren't in the open world: channels are the world's, and a dungeon is a copy of its own.</p>`;
    else {
      const lines = channelLines(v, wait)
        .map((c) => {
          const tags = c.tags.map((t) => `<span class="tag${t === "You're Here" ? ' here' : ''}">${esc(t)}</span>`).join('');
          const go = c.here
            ? ''
            : `<button class="lui-btn small" data-act="change" data-arg="${c.n}"${c.why ? ` disabled title="${esc(c.why)}"` : ''}>Change</button>`;
          return `<div class="lui-row ch-row${c.here ? ' here' : ''}" data-channel="${c.n}"><b>${esc(c.name)}</b>${tags}${go}</div>`;
        })
        .join('');
      const following = v.following && v.party ? `<p class="note">You'll join your party in ${esc(channelName(v.party))} as soon as you can.</p>` : '';
      // What stops you as you stand, and the wait since your last change, each said; else the rules.
      const why = [v.blocked, wait > 0 ? `You can change channel again in ${shortWait(wait)}.` : null].filter((x): x is string => !!x);
      body =
        (closing ? `<p class="note ch-closing">${esc(closing)}</p>` : '') +
        `${lines}${following}` +
        (why.length ? why : [rulesLine()]).map((w) => `<p class="note ch-why">${esc(w)}</p>`).join('');
    }
    const join = !!v?.party && !!v.here && !v.following;
    this.win.innerHTML =
      `<div class="mw-bar">Channels${region ? ` <small>${esc(region)}</small>` : ''}</div><div class="mw-x" data-act="close" title="Close (Esc)">✕</div>` +
      `<div class="mw-body">${body}</div>` +
      `<div class="mw-foot"><span class="note">${join && v?.party ? `Your party is in ${esc(channelName(v.party))}.` : 'The land is the same in every channel.'}</span>` +
      (join ? `<button class="lui-btn gold" data-act="party"${stopped ? ` disabled title="${esc(stopped)}"` : ''}>Join Your Party</button>` : '') +
      `</div>`;
  }

  private onClick(e: MouseEvent): void {
    const b = (e.target as Element).closest('[data-act]') as HTMLElement | null;
    if (!b || b.hasAttribute('disabled')) return;
    e.stopPropagation();
    const act = b.dataset.act;
    if (act === 'close') this.close();
    else if (act === 'change') this.d.link.changeChannel(Number(b.dataset.arg));
    else if (act === 'party') this.d.link.changeChannel('party');
  }

  // ---------- For tests ----------

  state() {
    return {
      channels: this.d.link.channels,
      moved: this.d.link.moved,
      windows: { window: !this.win.hidden, notice: !this.notice.hidden },
      notice: this.notice.innerText,
      rows: [...this.win.querySelectorAll('[data-channel]')].map((r) => (r as HTMLElement).innerText),
    };
  }
}
