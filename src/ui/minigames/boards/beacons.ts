import './beacons.css';
import { type MiniGameDef, SEAT_COLORS } from '../../../content/minigames';
import { minigameLayout, minigameOptions } from '../../../engine/minigames';
import { esc } from '../../../util/html';
import { hexCentre } from '../../../util/hex';
import { iconHtml, iconUrl } from '../../theme/icons';
import type { BoardMenu, BoardView, MakeBoardView, TableView } from '../tables';

// Beacons at your table (its rules are crates/engine/src/minigames/games/beacons.rs): the hex
// board, your hand, the Harbour and the deck, and what to do next. Pick a card (or two of a kind)
// and the hexes it can light glow; pick one of those to light it; then take cards from the Harbour
// or the deck until you hold four again. Only what the server sends is shown, and what you pick
// goes to it as a move; it answers with the game as it now stands. What may be picked, lit, swapped
// and drawn the board asks of the same rules, through the engine (`options`), and works out none of
// it itself: it offers just what the server would take.

/** Beacons' own part of its content (`rules`), as much as its board shows. */
interface BeaconsRules {
  row: number;
  goods: Array<{ id: string; name: string; icon: string; color: string }>;
}

/** The board as Beacons' rules lay it out (beacons.rs `layout`): each hex in the order they're numbered, and the Old Beacon. */
interface BeaconsLayout {
  hexes: Array<{ q: number; r: number; good: number | null }>;
  centre: number;
}

/** Beacons as the server shows it to you (beacons.rs Beacons::view). */
export interface BeaconsState {
  /** Per hex: 0 unlit, 1 seat 0's beacon, 2 seat 1's. */
  lit: number[];
  /** How many cards each seat holds. */
  cards: [number, number];
  harbour: Array<number | null>;
  deck: number;
  discards: number;
  turn: number;
  /** Cards the player to move still draws this turn. */
  draws: number;
  /** The winning row. */
  row: number[];
  log: BeaconsLog[];
  /** Your own hand (goods). */
  hand?: number[];
}

/** What you may do now, as Beacons' rules say from what you see (beacons.rs `Seen::options`). */
interface BeaconsOptions {
  /** Your turn to play: light a hex, or swap a card. */
  play: boolean;
  /** Your turn to draw back up. */
  draw: boolean;
  /** Each card in your hand: whether it lights a hex alone, the card it makes a pair with, whether it can be swapped. */
  cards: Array<{ light: boolean; pair: number | null; swap: boolean }>;
  /** The hexes the picked cards light. */
  hexes: number[];
  /** The picked card can be swapped. */
  swap: boolean;
  /** Each Harbour card: whether you may take it. */
  harbour: boolean[];
  /** Whether you may draw from the deck. */
  deck: boolean;
}

type BeaconsLog =
  | { seat: number; k: 'light'; goods: number[]; hex: number }
  | { seat: number; k: 'swap' }
  | { seat: number; k: 'harbour'; good: number }
  | { seat: number; k: 'deck' };

/** A board hex, middle to corner (virtual px). */
const SIZE = 27;
/** Small numbers in words, for the row that wins ("Four in a row!"). */
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** A colour part way to the board's parchment. */
function tint(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const p = [0xf6, 0xec, 0xd2];
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v, i) => Math.round(v + (p[i] - v) * t));
  return `rgb(${c.join(',')})`;
}

export const board: MakeBoardView = (game, index, send) => new BeaconsBoard(game, index, send);

class BeaconsBoard implements BoardView {
  /** The cards picked from your hand (their places in it). */
  picked: number[] = [];
  private seenKey = '';
  private name: string;
  private rules: BeaconsRules;
  private layout: BeaconsLayout;
  /** The last answer to `options`, and what it was asked of. */
  private asked: { state: unknown; toMove: number | null; picked: string; options: BeaconsOptions } | null = null;

  constructor(
    game: MiniGameDef,
    private index: number,
    private send: (m: Record<string, unknown>) => void,
  ) {
    this.name = game.name;
    this.rules = game.rules as BeaconsRules;
    this.layout = minigameLayout<BeaconsLayout>(index);
  }

  get key(): string {
    return this.picked.join();
  }

  private good(g: number | null | undefined) {
    return g === null || g === undefined ? undefined : this.rules.goods[g];
  }

  private goodName(g: number | null | undefined): string {
    return this.good(g)?.name ?? '?';
  }

  private s(v: TableView): BeaconsState {
    return v.state as unknown as BeaconsState;
  }

  seen(v: TableView): void {
    const s = this.s(v);
    const key = `${v.id}:${(s.hand ?? []).join()}:${s.draws}:${s.turn}:${v.over ? 1 : 0}`;
    if (key !== this.seenKey) {
      this.seenKey = key;
      this.picked = [];
    }
  }

  /** What you may do now with the cards `picked` picked, as the rules say from what you see (asked of the engine once a view and a pick). */
  private options(v: TableView, picked: number[] = this.picked): BeaconsOptions {
    const key = picked.join();
    const a = this.asked;
    if (a && a.state === v.state && a.toMove === v.toMove && a.picked === key) return a.options;
    const options = minigameOptions<BeaconsOptions>(this.index, { you: v.you, toMove: v.over ? null : v.toMove, view: v.state, picked });
    if (picked === this.picked) this.asked = { state: v.state, toMove: v.toMove, picked: key, options };
    return options;
  }

  /** The hexes the picked cards can light. */
  private targets(v: TableView): Set<number> {
    return new Set(this.picked.length ? this.options(v).hexes : []);
  }

  hint(v: TableView): string {
    const s = this.s(v);
    const them = esc(v.seats[1 - v.you]?.name ?? '');
    if (v.over) return '';
    const o = this.options(v);
    if (!o.play && !o.draw) return s.draws > 0 ? `${them} is drawing.` : `${them} is thinking.`;
    if (o.draw) return `Draw ${s.draws === 1 ? 'one more card' : `${s.draws} cards`}: take one from the <b>Harbour</b> or the top of the <b>deck</b>.`;
    const hand = s.hand ?? [];
    if (!this.picked.length)
      return 'Your turn. Pick a card, then a glowing hex to light with it. <b>Two of a kind</b> light any hex, even the Old Beacon. Or swap a card.';
    const g = hand[this.picked[0]];
    const name = esc(this.goodName(g));
    if (this.picked.length === 2) return `A pair of ${name} lights any unlit hex. Pick one.`;
    if (this.targets(v).size) return `Pick a glowing ${name} hex to light it.`;
    return `There's no unlit ${name} hex left. Pick another ${name} to make a pair, or swap this card.`;
  }

  body(v: TableView): string {
    return this.board(v) + this.cards(v);
  }

  /** The board, as an SVG. */
  private board(v: TableView): string {
    const s = this.s(v);
    const can = this.targets(v);
    const picking = this.picked.length > 0 && this.options(v).play;
    const row = new Set(s.row ?? []);
    const hexes = this.layout.hexes;
    // The board's size: the widest row and the rows, with room for the rim.
    const xs = hexes.map((h) => hexCentre(h.q, h.r, SIZE).x);
    const ys = hexes.map((h) => hexCentre(h.q, h.r, SIZE).y);
    const w = Math.max(...xs) - Math.min(...xs) + Math.sqrt(3) * SIZE + 8;
    const h = Math.max(...ys) - Math.min(...ys) + SIZE * 2 + 8;
    const corners = (cx: number, cy: number, r: number) =>
      Array.from({ length: 6 }, (_, k) => {
        const a = ((60 * k - 30) * Math.PI) / 180;
        return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
      }).join(' ');
    const defs =
      this.rules.goods.map((g, k) => `<image id="mg-g${k}" href="${iconUrl(g.icon) ?? ''}" width="22" height="22"/>`).join('') +
      `<image id="mg-fire" href="${iconUrl('🔥') ?? ''}" width="18" height="18"/>`;
    const cells = hexes
      .map((hx, i) => {
        const c = hexCentre(hx.q, hx.r, SIZE);
        const cx = c.x + w / 2;
        const cy = c.y + h / 2;
        const lit = s.lit?.[i] ?? 0;
        const old = i === this.layout.centre;
        const fill = old ? '#3d2614' : tint(this.good(hx.good)?.color ?? '#c9a06a', 0.3);
        const cls = ['hx', old ? 'old' : '', can.has(i) ? 'can' : '', row.has(i) ? 'row' : '', picking && !can.has(i) && !lit ? 'dim' : '']
          .filter(Boolean)
          .join(' ');
        const name = old ? 'The Old Beacon: only a pair lights it' : this.goodName(hx.good);
        let body = `<polygon points="${corners(cx, cy, SIZE - 1)}" fill="${fill}"/>`;
        // The Old Beacon: an unlit brazier, a ring of brass.
        body += old
          ? `<circle cx="${cx}" cy="${cy}" r="10" fill="none" stroke="#e0b84a" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="3.5" fill="#e0b84a"/>`
          : `<use href="#mg-g${hx.good}" x="${cx - 11}" y="${cy - 11}"/>`;
        if (lit) {
          const colour = SEAT_COLORS[lit - 1] ?? '#fff';
          body += `<circle class="beacon" cx="${cx}" cy="${cy}" r="${SIZE * 0.52}" fill="${colour}"/><circle class="glint" cx="${cx - 4}" cy="${cy - 5}" r="3"/><use href="#mg-fire" x="${cx - 9}" y="${cy - 10}"/>`;
        }
        return `<g class="${cls}" data-act="hex" data-arg="${i}"><title>${esc(name)}</title>${body}</g>`;
      })
      .join('');
    return `<svg class="mg-board" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}"><defs>${defs}</defs>${cells}</svg>`;
  }

  /** Your hand, the Harbour and the deck. */
  private cards(v: TableView): string {
    const s = this.s(v);
    const o = this.options(v);
    const card = (g: number, attrs: string, cls: string) => {
      const d = this.good(g);
      return `<div class="mg-card ${cls}" ${attrs} style="--c:${d?.color ?? '#c9a06a'}" data-tip="mg:good:${g}">${iconHtml(d?.icon ?? '❔', undefined, 32)}<span>${esc(d?.name ?? '')}</span></div>`;
    };
    const pickable = (i: number) => {
      const c = o.cards[i];
      return !!c && (c.light || c.pair !== null || c.swap);
    };
    const hand = (s.hand ?? [])
      .map((g, i) => card(g, `data-act="card" data-arg="${i}"`, `${pickable(i) ? 'can' : ''}${this.picked.includes(i) ? ' picked' : ''}`))
      .join('');
    const harbour = (s.harbour ?? [])
      .map((g, i) => (g === null ? `<div class="mg-card empty"></div>` : card(g, `data-act="harbour" data-arg="${i}"`, o.harbour[i] ? 'take' : '')))
      .join('');
    const deck = `<div class="mg-card back${o.deck ? ' take' : ''}" data-act="deck" title="The deck"><b>${s.deck}</b><span>Cards</span></div>`;
    return (
      `<div class="h">Your Hand</div><div class="mg-cards hand">${hand}</div>` +
      `<div class="mg-row2"><div><div class="h">Harbour</div><div class="mg-cards">${harbour}</div></div><div><div class="h">Deck</div><div class="mg-cards">${deck}</div></div></div>`
    );
  }

  log(v: TableView): string {
    const s = this.s(v);
    const who = (seat: number) => (seat === v.you ? 'You' : esc(v.seats[seat]?.name ?? ''));
    const line = (e: BeaconsLog) => {
      if (e.k === 'light') {
        const name = this.goodName(this.layout.hexes[e.hex]?.good);
        const where = e.hex === this.layout.centre ? 'the Old Beacon' : `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${esc(name)} hex`;
        return `${who(e.seat)} lit ${where}${e.goods.length === 2 ? ` with a pair of ${esc(this.goodName(e.goods[0]))}` : ''}.`;
      }
      if (e.k === 'swap') return `${who(e.seat)} swapped a card.`;
      if (e.k === 'harbour') return `${who(e.seat)} took ${esc(this.goodName(e.good))} from the Harbour.`;
      return `${who(e.seat)} drew from the deck.`;
    };
    return (s.log ?? []).slice(-2).map(line).join(' ');
  }

  buttons(v: TableView): string {
    const swap = this.options(v).swap;
    return `<button class="lui-btn" data-act="swap"${swap ? '' : ' disabled'} title="${swap ? 'Discard the picked card and draw one: your whole turn' : 'Pick the card to swap first'}">Swap a Card</button>`;
  }

  ended(v: TableView): string {
    const o = v.over;
    const row = WORDS[this.rules.row] ?? String(this.rules.row);
    if (!o || o.winner === null) return 'Every hex is lit and nobody has a row.';
    if (o.winner === v.you) return `${row} in a row!`;
    return `${esc(v.seats[o.winner]?.name ?? '')} lit ${row.toLowerCase()} in a row.`;
  }

  click(v: TableView, act: string, arg: string): void {
    const o = this.options(v);
    const i = Number(arg);
    if (act === 'card') {
      if (o.play) this.pick(v, i);
    } else if (act === 'hex') {
      if (this.targets(v).has(i)) {
        this.send({ k: 'light', cards: [...this.picked], hex: i });
        this.picked = [];
      }
    } else if (act === 'harbour') {
      if (o.harbour[i]) this.send({ k: 'draw', from: 'harbour', i });
    } else if (act === 'deck') {
      if (o.deck) this.send({ k: 'draw', from: 'deck' });
    } else if (act === 'swap') this.swap(v);
  }

  /** A double-click on a card: it and its pair, if you hold two of a kind. */
  dblclick(v: TableView, act: string, arg: string): void {
    const o = this.options(v);
    if (act !== 'card' || !o.play) return;
    const i = Number(arg);
    const j = o.cards[i]?.pair ?? null;
    this.picked = j === null ? [i] : [i, j];
  }

  /** Picks card `i`: one card, or a second that the rules take as a pair with the first. Picking it again puts it back. */
  private pick(v: TableView, i: number): void {
    if (this.picked.includes(i)) this.picked = this.picked.filter((k) => k !== i);
    else if (this.picked.length === 1 && this.options(v, [this.picked[0], i]).hexes.length) this.picked = [this.picked[0], i];
    else this.picked = [i];
  }

  /** Swap the one card picked: the whole turn. */
  private swap(v: TableView): void {
    if (!this.options(v).swap) return;
    this.send({ k: 'swap', card: this.picked[0] });
    this.picked = [];
  }

  /**
   * A card's right-click menu: what you can do with it now. Its main action, which a double-click
   * does too, is the pair when you hold two of a kind, else the card alone.
   */
  menu(v: TableView, act: string, arg: string): BoardMenu | null {
    if (act !== 'card') return null;
    const i = Number(arg);
    const o = this.options(v);
    const c = o.cards[i];
    if (!c) return null;
    const g = (this.s(v).hand ?? [])[i];
    const wait = o.play ? undefined : 'Wait for your turn';
    const j = c.pair;
    return {
      title: this.goodName(g),
      entries: [
        {
          label: 'Light a Hex',
          primary: j === null,
          disabled: wait ?? (c.light ? undefined : `No unlit ${this.goodName(g)} hex left`),
          run: () => (this.picked = [i]),
        },
        {
          label: 'Light Any Hex With the Pair',
          primary: j !== null,
          disabled: wait ?? (j !== null ? undefined : 'You need two of a kind'),
          run: () => (this.picked = j === null ? [i] : [i, j]),
        },
        {
          label: 'Swap This Card',
          disabled: wait ?? (c.swap ? undefined : "This card can't be swapped now"),
          run: () => {
            this.picked = [i];
            this.swap(v);
          },
        },
      ],
    };
  }

  /** A good's tooltip (`mg:good:<good>`). */
  tip(key: string): string | null {
    const m = /^good:(\d+)$/.exec(key);
    const d = m ? this.good(Number(m[1])) : undefined;
    if (!d) return null;
    const name = esc(d.name);
    return `<h5>${name}</h5><div class="ty">${esc(this.name)} Card</div><p>Lights an unlit ${name} hex. Two ${name} cards together light any unlit hex, the Old Beacon too.</p>`;
  }

  state(): Record<string, unknown> {
    return { picked: [...this.picked] };
  }
}
