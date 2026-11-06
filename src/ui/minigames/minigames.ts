import './minigames.css';
import { CHALLENGE, MINIGAMES, type MiniGameDef, SEAT_COLORS, minigame, stakesFor } from '../../content/minigames';
import type { BoardView, ChallengeView, TableLink, TableView } from './tables';
import type { Life } from '../../engine/island';
import { docksLeft, type LifePress } from '../life/lifeUI';
import { closeMenu, openMenu } from '../theme/contextMenu';
import { iconHtml, money } from '../theme/icons';
import { uiRoot } from '../theme/scale';
import { addTipSource, hideTip } from '../theme/tooltip';
import { boardOf } from './boards';
import { esc } from '../../util/html';

// Mini-games, online: walk up to another player and press F to challenge them (the game and the
// stake, in the challenge window); they're asked in a window of their own and have a while to
// answer; if they accept, the server takes both stakes into the pot and throws a table down between
// you (src/render/open/gameTables.ts), and the game window opens for both of you. At the table you
// stay seated: the world's keys wait, and Escape (or Concede) offers to give the game up. The winner
// takes the pot. Everything here is what the server says (crates/server/src/play/tables.rs): the
// windows show it and send what you choose. Offline there's nobody to play, and none of this runs.
//
// These windows know no game: the games are the content's (MINIGAMES), and the game window draws a
// table's game with that game's board view (./boards/<game>.ts), which the window's own clicks
// (close, done, keep, concede) pass by.

export interface MinigamesDeps {
  link: TableLink;
  life: Life;
  /** Which of the island's windows is open, if any (Escape closes that first). */
  openPanel: () => string | null;
  /** The pointer is the camera's: let go of it, to use a window. */
  freeMouse: () => void;
}

function el(cls: string, id: string): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  e.id = id;
  e.hidden = true;
  return e;
}

/** Seconds as "0:32". */
function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A window's frame: bar, close cross, body and foot, as the island's windows are drawn. */
function frame(title: string, sub: string, body: string, foot: string, portrait = ''): string {
  return (
    (portrait ? `<div class="mw-portrait icon">${portrait}</div>` : '') +
    `<div class="mw-bar">${esc(title)}${sub ? ` <small>${sub}</small>` : ''}</div><div class="mw-x" data-act="close" title="Close (Esc)">✕</div>` +
    `<div class="mw-body">${body}</div>${foot ? `<div class="mw-foot">${foot}</div>` : ''}`
  );
}

export class MinigamesUI {
  private setup = el('mw left mg-win', 'mg-challenge');
  private invite = el('mw mg-win mg-invite', 'mg-invite');
  private game = el('mw left mg-win mg-game', 'mg-game');
  /** Who you're about to challenge (their window is open). */
  private target: { id: number; name: string } | null = null;
  /** The game picked in the challenge window. */
  private gameId = MINIGAMES[0]?.id ?? '';
  private stake = 0;
  /** Your challenge went out: when it's answered (or lapses) its window closes. */
  private waiting = false;
  /** The Concede button was pressed once: it asks first. */
  private conceding = false;
  /** A finished game whose window you closed (its table stays a moment longer). */
  private dismissed = -1;
  /** The table whose window last opened, to free the pointer once per game. */
  private opened = -1;
  private sig = { setup: '', invite: '', game: '' };
  /** Each game's board view, made when a table of it first comes. */
  private boards = new Map<number, BoardView>();

  constructor(private d: MinigamesDeps) {
    for (const w of [this.setup, this.invite, this.game]) {
      w.addEventListener('click', (e) => this.onClick(e, w));
      uiRoot().append(w);
    }
    this.game.addEventListener('dblclick', (e) => {
      const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      const t = this.d.link.table;
      const view = t && this.boardFor(t);
      if (!b || !t || !view) return;
      view.dblclick(t, b.dataset.act!, b.dataset.arg ?? '');
      this.render(true);
    });
    this.game.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      const t = this.d.link.table;
      const view = t && this.boardFor(t);
      const m = b && t && view ? view.menu(t, b.dataset.act!, b.dataset.arg ?? '') : null;
      if (!m) return;
      openMenu(
        e.clientX,
        e.clientY,
        m.title,
        m.entries.map((x) => ({ ...x, run: () => (x.run?.(), this.render(true)) })),
      );
    });
    // A board's tooltips (data-tip="mg:<key>"), from the board of the game at your table.
    addTipSource((tip) => {
      const t = this.d.link.table;
      return tip.startsWith('mg:') && t ? (this.boardFor(t)?.tip(tip.slice(3)) ?? null) : null;
    });
    d.link.onTable = () => this.render(true);
    d.link.onChallenges = () => this.render(true);
  }

  /** The board view of the game at table `t`: its game's (./boards/<game>.ts), made the first time. */
  private boardFor(t: TableView): BoardView | null {
    let view = this.boards.get(t.game);
    if (!view) {
      const def = MINIGAMES[t.game];
      const make = def && boardOf(def);
      if (!def || !make) return null;
      view = make(def, t.game, (m) => {
        const now = this.d.link.table;
        if (now) this.d.link.move(now.id, m);
      });
      this.boards.set(t.game, view);
    }
    return view;
  }

  /** At a table: you can't walk off, and the world's keys wait. */
  get seated(): boolean {
    return this.d.link.table !== null;
  }

  /**
   * A key, before the island's windows and the world see it: F on another player opens the
   * challenge window; at a table the world's keys wait and Escape asks whether to concede.
   */
  intercept(k: LifePress): boolean {
    const seated = this.seated;
    if (k === 'interact') {
      if (seated) return true;
      const f = this.d.life.focus;
      if (f?.action !== 'challenge') return false;
      if (f.ok && f.other) this.open(f.other, f.label.replace(/^Challenge /, ''));
      return true;
    }
    if (seated && (k === 'drop' || k === 'mount' || k === 'glider' || k === 'seed' || k === 'autorun')) return true;
    if (k === 'escape') {
      if (this.conceding) {
        this.conceding = false;
        this.render(true);
        return true;
      }
      // Backing out: of the challenge you're writing (or withdrawing it), or of the one asking you.
      if (this.target) {
        this.closeSetup();
        return true;
      }
      const asked = this.d.link.challenges.waiting;
      if (asked) {
        this.d.link.answer(asked.from, false);
        return true;
      }
      const t = this.d.link.table;
      if (t && !t.over && this.d.openPanel() === null) {
        this.conceding = true;
        this.render(true);
        return true;
      }
    }
    return false;
  }

  /** Opens the challenge window for another player. */
  open(id: number, name: string): void {
    if (this.seated) return;
    this.target = { id, name };
    this.waiting = false;
    const can = stakesFor(this.d.life.state.coins);
    if (!can.includes(this.stake)) this.stake = 0;
    this.d.freeMouse();
    this.render(true);
  }

  private closeSetup(): void {
    if (this.waiting) this.d.link.withdraw();
    this.target = null;
    this.waiting = false;
    this.setup.hidden = true;
    this.setup.innerHTML = '';
    hideTip();
  }

  /** Every frame: windows follow what the server last said, and the clocks run. */
  update(): void {
    document.body.classList.toggle('mg-seated', this.seated);
    this.render(false);
    const now = performance.now();
    const link = this.d.link;
    const left = (c: { ms: number } | null | undefined, heard: number) => (c ? c.ms - (now - heard) : 0);
    for (const e of this.setup.querySelectorAll<HTMLElement>('[data-clock]'))
      this.tick(e, left(link.challenges.sent, link.challengesHeard), CHALLENGE.inviteSeconds);
    for (const e of this.invite.querySelectorAll<HTMLElement>('[data-clock]'))
      this.tick(e, left(link.challenges.waiting, link.challengesHeard), CHALLENGE.inviteSeconds);
    const t = link.table;
    if (t && !t.over) {
      const ms = left(t, link.tableHeard);
      for (const e of this.game.querySelectorAll<HTMLElement>('[data-clock]')) {
        const text = clock(ms);
        const b = e.firstChild as Text | null;
        if (b && b.nodeValue !== text) b.nodeValue = text;
        e.classList.toggle('low', ms < 10_000);
      }
    }
  }

  /** A countdown: its bar and its "12s left". */
  private tick(e: HTMLElement, ms: number, of: number): void {
    const text = `${Math.max(0, Math.ceil(ms / 1000))}s left to answer`;
    if (e.textContent !== text) e.textContent = text;
    const bar = e.parentElement?.querySelector<HTMLElement>('.mg-time i');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, (ms / (of * 1000)) * 100)).toFixed(1)}%`;
  }

  // ---------- Drawing the windows ----------

  private render(force: boolean): void {
    this.renderSetup(force);
    this.renderInvite(force);
    this.renderGame(force);
  }

  private renderSetup(force: boolean): void {
    const sent = this.d.link.challenges.sent;
    if (sent) this.waiting = true;
    else if (this.waiting) {
      // Answered, refused or lapsed: the toast says which.
      this.target = null;
      this.waiting = false;
    }
    if (!this.target || this.seated) {
      if (!this.setup.hidden) {
        this.setup.hidden = true;
        this.setup.innerHTML = '';
        this.sig.setup = '';
      }
      if (this.seated) this.target = null;
      return;
    }
    const coins = this.d.life.state.coins;
    const sig = `${this.target.id}|${this.gameId}|${this.stake}|${coins}|${sent ? `${sent.to}:${sent.stake}` : ''}`;
    if (!force && sig === this.sig.setup && !this.setup.hidden) return;
    this.sig.setup = sig;
    const name = this.target.name;
    const g: MiniGameDef | undefined = (sent ? MINIGAMES[sent.game] : minigame(this.gameId)) ?? MINIGAMES[0];
    const icon = g ? iconHtml(g.icon, undefined, 40) : '';
    let html: string;
    if (sent) {
      const stake = sent.stake ? `for ${money(sent.stake, 14)} each` : 'with no stake';
      html = frame(
        `Challenge ${sent.toName}`,
        '',
        `<p class="mg-say">Waiting for <b>${esc(sent.toName)}</b> to answer your challenge to <b>${esc(g?.name ?? '')}</b> ${stake}.</p><div class="mg-time"><i></i></div><p class="note" data-clock></p>`,
        `<span></span><button class="lui-btn" data-act="withdraw">Withdraw</button>`,
        icon,
      );
    } else {
      const games = MINIGAMES.map(
        (x) =>
          `<div class="lui-row${x.id === this.gameId ? ' sel' : ''}" data-act="game" data-arg="${esc(x.id)}"><div class="ib">${iconHtml(x.icon, undefined, 32)}</div><div class="body"><b>${esc(x.name)}</b><small>${esc(x.blurb)}</small><small>${esc(x.players)}</small></div></div>`,
      ).join('');
      const stakes = CHALLENGE.stakes
        .filter((s) => s <= coins)
        .map((s) => `<span class="mg-stake${s === this.stake ? ' sel' : ''}" data-act="stake" data-arg="${s}">${s ? money(s, 14) : 'No Stake'}</span>`)
        .join('');
      html = frame(
        `Challenge ${name}`,
        '',
        `<div class="h">Game</div><div class="mg-games">${games}</div><div class="h">Stake</div><div class="mg-stakes">${stakes}</div>` +
          `<p class="note" style="margin-top:10px">You each put the stake in the pot, and the winner takes it all. A draw gives each stake back. ${esc(name)} has ${CHALLENGE.inviteSeconds} seconds to answer.</p>`,
        `<button class="lui-btn" data-act="cancel">Cancel</button><button class="lui-btn gold" data-act="send">Send Challenge</button>`,
        icon,
      );
    }
    this.setup.className = 'mw left mg-win has-portrait';
    this.setup.style.width = '420px';
    this.setup.innerHTML = html;
    this.setup.hidden = false;
  }

  private renderInvite(force: boolean): void {
    const w: ChallengeView | null = this.d.link.challenges.waiting;
    if (!w) {
      if (!this.invite.hidden) {
        this.invite.hidden = true;
        this.invite.innerHTML = '';
        this.sig.invite = '';
      }
      return;
    }
    const coins = this.d.life.state.coins;
    const short = w.stake > coins;
    const sig = `${w.from}|${w.stake}|${w.game}|${short}`;
    if (!force && sig === this.sig.invite && !this.invite.hidden) return;
    const fresh = this.invite.hidden;
    this.sig.invite = sig;
    const g = MINIGAMES[w.game];
    const stake = w.stake ? `for ${money(w.stake, 14)} each` : 'for no stake';
    this.invite.innerHTML = frame(
      'A Challenge',
      '',
      `<p class="mg-say"><b>${esc(w.fromName)}</b> challenges you to <b>${esc(g?.name ?? '')}</b> ${stake}.</p>` +
        `<p class="note">${esc(g?.blurb ?? '')}${w.stake ? ' The winner takes the pot.' : ''}</p>` +
        (short ? `<p class="note" style="color:var(--bad)">You don't have enough to match the stake.</p>` : '') +
        `<div class="mg-time"><i></i></div><p class="note" data-clock></p>`,
      `<button class="lui-btn" data-act="decline">Decline</button><button class="lui-btn gold" data-act="accept"${short ? ' disabled' : ''}>Accept</button>`,
    );
    this.invite.hidden = false;
    if (fresh) this.d.freeMouse();
  }

  private renderGame(force: boolean): void {
    const link = this.d.link;
    const t = link.table;
    const covered = docksLeft(this.d.openPanel());
    if (!t || t.id === this.dismissed || covered) {
      if (!t) {
        this.conceding = false;
        this.dismissed = -1;
      }
      if (!this.game.hidden) {
        this.game.hidden = true;
        this.game.innerHTML = '';
        this.sig.game = '';
        closeMenu();
        hideTip();
      }
      return;
    }
    const view = this.boardFor(t);
    view?.seen(t);
    const sig = `${t.id}|${link.tableHeard}|${view?.key ?? ''}|${this.conceding}`;
    if (!force && sig === this.sig.game && !this.game.hidden) return;
    this.sig.game = sig;
    if (this.opened !== t.id) {
      this.opened = t.id;
      this.d.freeMouse();
    }
    const g = MINIGAMES[t.game];
    const me = t.you;
    const them = t.seats[1 - me]?.name ?? '';
    const pot = t.stake * 2;
    const seat = (k: number) => {
      const s = t.seats[k];
      const on = !t.over && t.toMove === k;
      const tag = k === me ? '<span class="tag" style="color:var(--ink-2)">You</span>' : s?.away ? '<span class="tag">Away</span>' : '';
      return `<div class="mg-seat${on ? ' on' : ''}"><i class="dot" style="background:${SEAT_COLORS[k]}"></i><span>${esc(s?.name ?? '')}</span>${tag}</div>`;
    };
    const turnLabel = t.over ? '' : t.toMove === me ? 'Your Turn' : `${them}'s Turn`;
    const clockHtml = t.over ? '' : `<div class="mg-clock" data-clock>${clock(t.ms)}<small>${esc(turnLabel)}</small></div>`;
    let top = `<div class="mg-seats">${seat(0)}${clockHtml}${seat(1)}</div>`;
    if (t.over) top += this.result(t, view);
    else top += `<div class="mg-hint">${view?.hint(t) ?? ''}</div>`;
    const board = view ? view.body(t) + `<div class="mg-log">${view.log(t)}</div>` : `<p class="note">This game can't be shown here.</p>`;
    let foot: string;
    if (t.over) foot = `<span></span><button class="lui-btn" data-act="done">Close</button>`;
    else if (this.conceding) {
      foot = `<span class="mg-confirm">Concede the game? ${pot ? `${esc(them)} takes the pot.` : `${esc(them)} wins.`}</span><button class="lui-btn small" data-act="keep">Keep Playing</button><button class="lui-btn" data-act="concede">Concede</button>`;
    } else foot = `${view?.buttons(t) ?? ''}<button class="lui-btn" data-act="concede">Concede</button>`;
    const keep = this.game.querySelector('.mw-body')?.scrollTop ?? 0;
    this.game.innerHTML = frame(g?.name ?? '', pot ? `Pot ${money(pot, 13)}` : 'No Stake', top + board, foot);
    const nb = this.game.querySelector('.mw-body');
    if (nb) nb.scrollTop = keep;
    this.game.hidden = false;
  }

  /** How the game ended, for both players: by the rules in the game's own words (its board view's), or for a reason every game has. */
  private result(t: TableView, view: BoardView | null): string {
    const o = t.over!;
    const me = t.you;
    const them = esc(t.seats[1 - me]?.name ?? '');
    const pot = t.stake * 2;
    const potText = pot ? ` The pot of ${money(pot, 14)} is yours.` : '';
    const back = t.stake ? ' Each stake goes back to its player.' : '';
    const byRules = view?.ended(t) ?? '';
    let big: string;
    let line: string;
    if (o.why === 'aborted') {
      big = 'Called Off';
      line = `The game was called off.${back}`;
    } else if (o.winner === null) {
      big = 'A Draw';
      line = `${byRules}${back}`;
    } else if (o.winner === me) {
      big = 'You Won';
      line =
        { rules: byRules, conceded: `${them} conceded.`, timeouts: `${them} ran out of time too often.`, away: `${them} was away too long.` }[o.why] + potText;
    } else {
      big = `${them} Won`;
      line = { rules: byRules, conceded: 'You conceded.', timeouts: 'You ran out of time too often.', away: 'You were away too long.' }[o.why] ?? '';
    }
    return `<div class="mg-result"><div class="big">${big}</div><p>${line}</p></div>`;
  }

  // ---------- Clicks ----------

  private onClick(e: MouseEvent, w: HTMLElement): void {
    const b = (e.target as Element).closest('[data-act]') as HTMLElement | null;
    if (!b || b.hasAttribute('disabled')) return;
    e.stopPropagation();
    const act = b.dataset.act!;
    const arg = b.dataset.arg ?? '';
    const link = this.d.link;
    if (w === this.setup) {
      if (act === 'close' || act === 'cancel') this.closeSetup();
      else if (act === 'withdraw') link.withdraw();
      else if (act === 'game') this.gameId = arg;
      else if (act === 'stake') this.stake = Number(arg);
      else if (act === 'send' && this.target) link.challenge(this.target.id, this.gameId, this.stake);
    } else if (w === this.invite) {
      const c = link.challenges.waiting;
      if (c && (act === 'accept' || act === 'decline' || act === 'close')) link.answer(c.from, act === 'accept');
    } else {
      const t = link.table;
      if (!t) return;
      if (act === 'done' || (act === 'close' && t.over)) this.dismissed = t.id;
      else if (act === 'close' || act === 'keep') this.conceding = act === 'close' ? !this.conceding : false;
      else if (act === 'concede') {
        if (this.conceding) {
          link.concede(t.id);
          this.conceding = false;
        } else this.conceding = true;
      } else this.boardFor(t)?.click(t, act, arg);
    }
    this.render(true);
  }

  // ---------- For tests ----------

  /** What the windows show, the game as the server last sent it, and what its board holds (Beacons: the cards picked). */
  state() {
    const link = this.d.link;
    const t = link.table;
    return {
      seated: this.seated,
      windows: { challenge: !this.setup.hidden, invite: !this.invite.hidden, game: !this.game.hidden },
      challenges: link.challenges,
      table: t,
      board: t ? (this.boardFor(t)?.state() ?? null) : null,
    };
  }
}
