import { BEACONS, HEXES, OLD_BEACON, SEAT_COLORS, hexCentre } from '../../content/minigames';
import type { TableView } from '../../net/worldLink';
import { iconHtml, iconUrl } from '../theme/icons';
import type { MenuEntry } from '../theme/contextMenu';

// Beacons at your table (the rules are the server's: server/src/minigames/beacons.rs): the hex
// board, your hand, the Harbour and the deck, and what to do next. Pick a card (or two of a kind)
// and the hexes it can light glow; pick one of those to light it; then take cards from the Harbour
// or the deck until you hold four again. Only what the server sends is shown, and what you pick
// goes to it as a move; it answers with the game as it now stands.

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
  /** Your turn, before you've played: each way to light a hex (cards: places in your hand). */
  legal?: Array<{ cards: number[]; hexes: number[] }>;
}

export type BeaconsLog = { seat: number; k: 'light'; goods: number[]; hex: number } | { seat: number; k: 'swap' } | { seat: number; k: 'harbour'; good: number } | { seat: number; k: 'deck' };

/** A board hex, middle to corner (virtual px). */
const SIZE = 27;
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const good = (g: number) => BEACONS.goods[g];
const goodName = (g: number) => good(g)?.name ?? '?';
const sameCards = (a: number[], b: number[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** A colour part way to the board's parchment. */
function tint(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const p = [0xf6, 0xec, 0xd2];
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v, i) => Math.round(v + (p[i] - v) * t));
  return `rgb(${c.join(',')})`;
}

export class BeaconsPanel {
  /** The cards picked from your hand (their places in it). */
  picked: number[] = [];
  private seenKey = '';

  constructor(private send: (m: Record<string, unknown>) => void) {}

  private s(v: TableView): BeaconsState {
    return v.state as unknown as BeaconsState;
  }

  /** A new view of the game: picks that no longer make sense go. */
  seen(v: TableView): void {
    const s = this.s(v);
    const key = `${v.id}:${(s.hand ?? []).join()}:${s.draws}:${s.turn}:${v.over ? 1 : 0}`;
    if (key !== this.seenKey) {
      this.seenKey = key;
      this.picked = [];
    }
  }

  private mine(v: TableView): boolean {
    return !v.over && v.toMove === v.you;
  }

  /** Your turn, and you haven't played yet. */
  playing(v: TableView): boolean {
    return this.mine(v) && this.s(v).draws === 0;
  }

  /** Your turn, drawing back up. */
  drawing(v: TableView): boolean {
    return this.mine(v) && this.s(v).draws > 0;
  }

  /** The hexes the picked cards can light. */
  private targets(v: TableView): Set<number> {
    if (!this.playing(v) || !this.picked.length) return new Set();
    const l = this.s(v).legal?.find((x) => sameCards(x.cards, this.picked));
    return new Set(l?.hexes ?? []);
  }

  /** What to do now, in a sentence or two. */
  hint(v: TableView): string {
    const s = this.s(v);
    const them = esc(v.seats[1 - v.you]?.name ?? '');
    if (v.over) return '';
    if (!this.mine(v)) return s.draws > 0 ? `${them} is drawing.` : `${them} is thinking.`;
    if (s.draws > 0) return `Draw ${s.draws === 1 ? 'one more card' : `${s.draws} cards`}: take one from the <b>Harbour</b> or the top of the <b>deck</b>.`;
    const hand = s.hand ?? [];
    if (!this.picked.length) return 'Your turn. Pick a card, then a glowing hex to light with it. <b>Two of a kind</b> light any hex, even the Old Beacon. Or swap a card.';
    const g = hand[this.picked[0]];
    if (this.picked.length === 2) return `A pair of ${esc(goodName(g))} lights any unlit hex. Pick one.`;
    if (this.targets(v).size) return `Pick a glowing ${esc(goodName(g))} hex to light it.`;
    return `There's no unlit ${esc(goodName(g))} hex left. Pick another ${esc(goodName(g))} to make a pair, or swap this card.`;
  }

  /** The board, as an SVG. */
  board(v: TableView): string {
    const s = this.s(v);
    const can = this.targets(v);
    const picking = this.picked.length > 0 && this.playing(v);
    const row = new Set(s.row ?? []);
    const w = Math.sqrt(3) * SIZE * 7 + 8;
    const h = SIZE * 1.5 * 6 + SIZE * 2 + 8;
    const corners = (cx: number, cy: number, r: number) =>
      Array.from({ length: 6 }, (_, k) => {
        const a = ((60 * k - 30) * Math.PI) / 180;
        return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
      }).join(' ');
    const defs = BEACONS.goods.map((g, k) => `<image id="mg-g${k}" href="${iconUrl(g.icon) ?? ''}" width="22" height="22"/>`).join('') + `<image id="mg-fire" href="${iconUrl('🔥') ?? ''}" width="18" height="18"/>`;
    const hexes = HEXES.map((hx, i) => {
      const c = hexCentre(hx, SIZE);
      const cx = c.x + w / 2;
      const cy = c.y + h / 2;
      const lit = s.lit?.[i] ?? 0;
      const old = i === OLD_BEACON;
      const fill = old ? '#3d2614' : tint(good(hx.good)?.color ?? '#c9a06a', 0.3);
      const cls = ['hx', old ? 'old' : '', can.has(i) ? 'can' : '', row.has(i) ? 'row' : '', picking && !can.has(i) && !lit ? 'dim' : ''].filter(Boolean).join(' ');
      const name = old ? 'The Old Beacon: only a pair lights it' : goodName(hx.good);
      let body = `<polygon points="${corners(cx, cy, SIZE - 1)}" fill="${fill}"/>`;
      // The Old Beacon: an unlit brazier, a ring of brass.
      body += old ? `<circle cx="${cx}" cy="${cy}" r="10" fill="none" stroke="#e0b84a" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="3.5" fill="#e0b84a"/>` : `<use href="#mg-g${hx.good}" x="${cx - 11}" y="${cy - 11}"/>`;
      if (lit) {
        const colour = SEAT_COLORS[lit - 1] ?? '#fff';
        body += `<circle class="beacon" cx="${cx}" cy="${cy}" r="${SIZE * 0.52}" fill="${colour}"/><circle class="glint" cx="${cx - 4}" cy="${cy - 5}" r="3"/><use href="#mg-fire" x="${cx - 9}" y="${cy - 10}"/>`;
      }
      return `<g class="${cls}" data-act="hex" data-arg="${i}"><title>${esc(name)}</title>${body}</g>`;
    }).join('');
    return `<svg class="mg-board" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}"><defs>${defs}</defs>${hexes}</svg>`;
  }

  /** Your hand, the Harbour and the deck. */
  cards(v: TableView): string {
    const s = this.s(v);
    const playing = this.playing(v);
    const drawing = this.drawing(v);
    const card = (g: number, attrs: string, cls: string) => {
      const d = good(g);
      return `<div class="mg-card ${cls}" ${attrs} style="--c:${d?.color ?? '#c9a06a'}" data-tip="mg:good:${g}">${iconHtml(d?.icon ?? '❔', undefined, 32)}<span>${esc(d?.name ?? '')}</span></div>`;
    };
    const hand = (s.hand ?? []).map((g, i) => card(g, `data-act="card" data-arg="${i}"`, `${playing ? 'can' : ''}${this.picked.includes(i) ? ' picked' : ''}`)).join('');
    const harbour = (s.harbour ?? []).map((g, i) => (g === null ? `<div class="mg-card empty"></div>` : card(g, `data-act="harbour" data-arg="${i}"`, drawing ? 'take' : ''))).join('');
    const deck = `<div class="mg-card back${drawing && s.deck + s.discards > 0 ? ' take' : ''}" data-act="deck" title="The deck"><b>${s.deck}</b><span>Cards</span></div>`;
    return (
      `<div class="h">Your Hand</div><div class="mg-cards hand">${hand}</div>` +
      `<div class="mg-row2"><div><div class="h">Harbour</div><div class="mg-cards">${harbour}</div></div><div><div class="h">Deck</div><div class="mg-cards">${deck}</div></div></div>`
    );
  }

  /** What happened last, in a sentence or two. */
  log(v: TableView): string {
    const s = this.s(v);
    const who = (seat: number) => (seat === v.you ? 'You' : esc(v.seats[seat]?.name ?? ''));
    const line = (e: BeaconsLog) => {
      if (e.k === 'light') {
        const name = goodName(HEXES[e.hex]?.good ?? -1);
        const where = e.hex === OLD_BEACON ? 'the Old Beacon' : `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${esc(name)} hex`;
        return `${who(e.seat)} lit ${where}${e.goods.length === 2 ? ` with a pair of ${esc(goodName(e.goods[0]))}` : ''}.`;
      }
      if (e.k === 'swap') return `${who(e.seat)} swapped a card.`;
      if (e.k === 'harbour') return `${who(e.seat)} took ${esc(goodName(e.good))} from the Harbour.`;
      return `${who(e.seat)} drew from the deck.`;
    };
    return (s.log ?? []).slice(-2).map(line).join(' ');
  }

  /** A click in the window: true if it was the game's. */
  click(v: TableView, act: string, arg: string): boolean {
    const s = this.s(v);
    const i = Number(arg);
    if (act === 'card') {
      if (this.playing(v)) this.pick(v, i);
      return true;
    }
    if (act === 'hex') {
      if (this.targets(v).has(i)) {
        this.send({ k: 'light', cards: [...this.picked], hex: i });
        this.picked = [];
      }
      return true;
    }
    if (act === 'harbour') {
      if (this.drawing(v) && s.harbour?.[i] !== null && s.harbour?.[i] !== undefined) this.send({ k: 'draw', from: 'harbour', i });
      return true;
    }
    if (act === 'deck') {
      if (this.drawing(v)) this.send({ k: 'draw', from: 'deck' });
      return true;
    }
    return false;
  }

  /** A double-click on a card: it and its pair, if you hold two of a kind. */
  pair(v: TableView, i: number): void {
    if (!this.playing(v)) return;
    const hand = this.s(v).hand ?? [];
    const j = hand.findIndex((g, k) => k !== i && g === hand[i]);
    this.picked = j >= 0 ? [i, j] : [i];
  }

  /** Picks card `i`: one card, or a second of the same good for a pair. Picking it again puts it back. */
  private pick(v: TableView, i: number): void {
    const hand = this.s(v).hand ?? [];
    if (this.picked.includes(i)) this.picked = this.picked.filter((k) => k !== i);
    else if (this.picked.length === 1 && hand[this.picked[0]] === hand[i]) this.picked = [this.picked[0], i];
    else this.picked = [i];
  }

  /** Swap the one card picked: the whole turn. */
  canSwap(v: TableView): boolean {
    return this.playing(v) && this.picked.length === 1;
  }

  swap(v: TableView): void {
    if (!this.canSwap(v)) return;
    this.send({ k: 'swap', card: this.picked[0] });
    this.picked = [];
  }

  /**
   * A card's right-click menu: what you can do with it now. Its main action, which a double-click
   * does too (pair), is the pair when you hold two of a kind, else the card alone.
   */
  menu(v: TableView, i: number): { title: string; entries: MenuEntry[] } {
    const s = this.s(v);
    const hand = s.hand ?? [];
    const g = hand[i];
    const wait = this.playing(v) ? undefined : 'Wait for your turn';
    const single = s.legal?.find((x) => sameCards(x.cards, [i]));
    const j = hand.findIndex((x, k) => k !== i && x === g);
    return {
      title: goodName(g),
      entries: [
        { label: 'Light a Hex', primary: j < 0, disabled: wait ?? (single ? undefined : `No unlit ${goodName(g)} hex left`), run: () => (this.picked = [i]) },
        { label: 'Light Any Hex With the Pair', primary: j >= 0, disabled: wait ?? (j >= 0 ? undefined : 'You need two of a kind'), run: () => (this.picked = [i, j]) },
        {
          label: 'Swap This Card',
          disabled: wait,
          run: () => {
            this.picked = [i];
            this.swap(v);
          },
        },
      ],
    };
  }

  /** A good's tooltip. */
  static tip(g: number): string | null {
    const d = good(g);
    if (!d) return null;
    return `<h5>${esc(d.name)}</h5><div class="ty">Beacons Card</div><p>Lights an unlit ${esc(d.name)} hex. Two ${esc(d.name)} cards together light any unlit hex, the Old Beacon too.</p>`;
  }
}
