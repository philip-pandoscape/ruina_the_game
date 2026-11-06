import { assignMovement, assignSlot, movementName, swapSlots } from '../../build';
import { BOOK, bookContext, hasSkill, MAX_LEVEL, modApplies, NODES, resolveSkills, skillCount, type BookSkill } from '../../skills';
import { ABILITIES, HOTBAR_SLOTS, MOVEMENT_SKILLS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT, WEAPONS, type Build } from '../../tuning';
import type { MenuPress } from '../../input/input';
import { iconHtml, uiIcon } from '../theme/icons';
import { esc, type SkillsContext } from './context';
import {
  BOOK_GROUPS,
  bookDesc,
  bookEntries,
  bookIcon,
  bookName,
  bookStats,
  bookTree,
  bookType,
  describeMod,
  grantingNode,
  levelProgress,
  levelsWithNext,
  treeColor,
  xpUnit,
} from './describe';

// The skill book: every skill you can use, its level and what it does, and where it sits on your
// hotbar. Learning happens in the tree; this is where you put what you've learned to use.

export const PAD_SLOT_LABELS = ['LT+A', 'LT+B', 'LT+X', 'LT+Y', 'RT+A', 'RT+B', 'RT+X', 'RT+Y'];
const KEY_SLOT_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const MOVE_KEYS = ['Q', 'E'];
const PAD_MOVE_KEYS = ['LB', 'RB'];

/** Rows a controller walks: the three groups of skills, then the hotbar, then the movement slots. */
type Row = { kind: 'book'; items: number[] } | { kind: 'slot'; items: number[] } | { kind: 'move'; items: number[] };

export class SkillBook {
  readonly el = document.createElement('div');
  /** The skill on the right-hand page (an index into BOOK). */
  selected = 0;
  /** An ability waiting for a hotbar slot (a controller's Y), or null. */
  assigning: number | null = null;
  private focus = { row: 0, col: 0 };
  private showFocus = false;
  private note = '';
  private dragging: { book?: number; slot?: number; move?: number } | null = null;

  constructor(
    private ctx: SkillsContext,
    private nav: { openTree(node?: number): void; close(): void },
  ) {
    this.el.className = 'sb-root';
    this.el.addEventListener('click', (e) => this.click(e));
    this.el.addEventListener('dblclick', (e) => {
      const b = this.bookAt(e.target);
      if (b !== null && BOOK[b].kind === 'weapon') this.equip(b);
    });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const t = e.target as HTMLElement;
      const slot = t.closest('[data-slot]') as HTMLElement | null;
      const move = t.closest('[data-move]') as HTMLElement | null;
      if (slot) this.change(assignSlot(this.build, Number(slot.dataset.slot), NO_ABILITY), `Slot ${Number(slot.dataset.slot) + 1} cleared.`);
      if (move) this.change(assignMovement(this.build, Number(move.dataset.move), NO_MOVEMENT), `${MOVE_KEYS[Number(move.dataset.move)]} cleared.`);
    });
    this.el.addEventListener('dragstart', (e) => this.dragStart(e));
    this.el.addEventListener('dragover', (e) => this.dragOver(e));
    this.el.addEventListener('drop', (e) => this.drop(e));
    this.el.addEventListener('dragend', () => {
      this.dragging = null;
      for (const x of this.el.querySelectorAll('.drop')) x.classList.remove('drop');
    });
  }

  private get build(): Build {
    return this.ctx.build();
  }

  /** Whether a book entry is yours to use: learned in the tree, or one everyone has (slide). */
  known(b: number): boolean {
    const s = BOOK[b];
    if (!s) return false;
    const r = resolveSkills(this.build.skills);
    if (s.kind === 'weapon') return r.weapons.includes(s.index);
    if (s.kind === 'ability') return r.abilities.includes(s.index);
    return !!MOVEMENT_SKILLS[s.index]?.builtin || r.movement.includes(s.index);
  }

  open(): void {
    this.note = '';
    this.showFocus = this.ctx.device() === 'gamepad';
    // Start on what you're holding.
    const w = BOOK.findIndex((b) => b.kind === 'weapon' && b.index === this.build.weapon);
    if (w >= 0) {
      this.selected = w;
      this.focus = { row: 0, col: Math.max(0, bookEntries('weapon').findIndex((x) => x.i === w)) };
    }
    this.render();
  }

  select(b: number): void {
    if (!BOOK[b]) return;
    this.selected = b;
    const at = this.rows().findIndex((r) => r.kind === 'book' && r.items.includes(b));
    if (at >= 0) this.focus = { row: at, col: this.rows()[at].items.indexOf(b) };
    this.render();
  }

  private change(b: Build, note: string): void {
    this.note = note;
    this.ctx.change(b, note);
    this.render();
  }

  private say(note: string): void {
    this.note = note;
    this.render();
  }

  // ---------- Doing things ----------

  equip(b: number): void {
    const s = BOOK[b];
    if (s?.kind !== 'weapon') return;
    if (!this.known(b)) return this.say(`Learn ${NODES[grantingNode(s)]?.name ?? bookName(s)} in the skill tree to use the ${bookName(s).toLowerCase()}.`);
    if (this.build.weapon === s.index) return this.say(`${bookName(s)} is already in your hands.`);
    this.change({ ...this.build, weapon: s.index }, `${bookName(s)} equipped.`);
  }

  /** Puts an ability on the bar: in `slot`, or the first empty one (else the first). */
  slotAbility(b: number, slot?: number): void {
    const s = BOOK[b];
    if (s?.kind !== 'ability' || !this.known(b)) return;
    const at = slot ?? (this.build.abilities.indexOf(NO_ABILITY) >= 0 ? this.build.abilities.indexOf(NO_ABILITY) : 0);
    this.change(assignSlot(this.build, at, s.index), `${bookName(s)} → slot ${at + 1}.`);
  }

  bindMovement(b: number, slot: number): void {
    const s = BOOK[b];
    if (s?.kind !== 'movement' || !this.known(b) || MOVEMENT_SKILLS[s.index]?.builtin) return;
    this.change(assignMovement(this.build, slot, s.index), `${bookName(s)} → ${MOVE_KEYS[slot]}.`);
  }

  startAssign(b: number): void {
    const s = BOOK[b];
    if (s?.kind !== 'ability' || !this.known(b)) return;
    this.assigning = s.index;
    this.say(`Placing ${bookName(s)}: hold a trigger and press a face button (${PAD_SLOT_LABELS[0]}…), or B to cancel.`);
  }

  cancelAssign(): void {
    this.assigning = null;
    this.say('');
  }

  /** A trigger and a face button while placing an ability: slot 1..8. */
  assignToSlot(slot: number): boolean {
    if (this.assigning === null || slot < 1 || slot > HOTBAR_SLOTS) return false;
    const a = this.assigning;
    this.assigning = null;
    this.change(assignSlot(this.build, slot - 1, a), `${ABILITIES[a]?.name ?? 'Ability'} → slot ${slot} (${PAD_SLOT_LABELS[slot - 1]}).`);
    return true;
  }

  // ---------- Mouse ----------

  private bookAt(t: EventTarget | null): number | null {
    const el = (t as HTMLElement | null)?.closest('[data-book]') as HTMLElement | null;
    return el ? Number(el.dataset.book) : null;
  }

  private click(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const act = (t.closest('[data-act]') as HTMLElement | null)?.dataset.act;
    if (act === 'close') return this.nav.close();
    if (act === 'tree') return this.nav.openTree();
    if (act === 'find') return this.nav.openTree(grantingNode(BOOK[this.selected]));
    if (act === 'equip') return this.equip(this.selected);
    if (act === 'slot') return this.slotAbility(this.selected);
    if (act === 'clear') {
      const s = BOOK[this.selected];
      const at = s.kind === 'ability' ? this.build.abilities.indexOf(s.index) : -1;
      if (at >= 0) this.change(assignSlot(this.build, at, NO_ABILITY), `Slot ${at + 1} cleared.`);
      const m = s.kind === 'movement' ? this.build.movement.indexOf(s.index) : -1;
      if (m >= 0) this.change(assignMovement(this.build, m, NO_MOVEMENT), `${MOVE_KEYS[m]} cleared.`);
      return;
    }
    if (act?.startsWith('bind')) return this.bindMovement(this.selected, Number(act.slice(4)));
    if (t.classList.contains('sb-dim')) return this.nav.close();
    this.showFocus = false;
    const b = this.bookAt(t);
    if (b !== null) return this.select(b);
    const slot = t.closest('[data-slot]') as HTMLElement | null;
    if (slot) return this.clickSlot(Number(slot.dataset.slot));
    const move = t.closest('[data-move]') as HTMLElement | null;
    if (move) return this.clickMove(Number(move.dataset.move));
  }

  /** A hotbar slot: the selected ability goes there; otherwise what's there is shown. */
  private clickSlot(i: number): void {
    if (this.assigning !== null) {
      this.assignToSlot(i + 1);
      return;
    }
    const s = BOOK[this.selected];
    if (s?.kind === 'ability' && this.known(this.selected) && this.build.abilities[i] !== s.index) return this.slotAbility(this.selected, i);
    const a = this.build.abilities[i];
    if (a !== NO_ABILITY) this.select(BOOK.findIndex((x) => x.kind === 'ability' && x.index === a));
  }

  private clickMove(i: number): void {
    const s = BOOK[this.selected];
    if (s?.kind === 'movement' && this.known(this.selected) && !MOVEMENT_SKILLS[s.index]?.builtin && this.build.movement[i] !== s.index) return this.bindMovement(this.selected, i);
    const m = this.build.movement[i];
    if (m !== NO_MOVEMENT) this.select(BOOK.findIndex((x) => x.kind === 'movement' && x.index === m));
  }

  private dragStart(e: DragEvent): void {
    const t = e.target as HTMLElement;
    const b = this.bookAt(t);
    const slot = t.closest('[data-slot]') as HTMLElement | null;
    const move = t.closest('[data-move]') as HTMLElement | null;
    if (b !== null && this.known(b) && (BOOK[b].kind === 'ability' || (BOOK[b].kind === 'movement' && !MOVEMENT_SKILLS[BOOK[b].index]?.builtin))) this.dragging = { book: b };
    else if (slot && this.build.abilities[Number(slot.dataset.slot)] !== NO_ABILITY) this.dragging = { slot: Number(slot.dataset.slot) };
    else if (move && this.build.movement[Number(move.dataset.move)] !== NO_MOVEMENT) this.dragging = { move: Number(move.dataset.move) };
    else {
      e.preventDefault();
      return;
    }
    e.dataTransfer?.setData('text/plain', 'skill');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  private dropTarget(e: DragEvent): HTMLElement | null {
    const d = this.dragging;
    if (!d) return null;
    const t = e.target as HTMLElement;
    const movement = d.move !== undefined || (d.book !== undefined && BOOK[d.book].kind === 'movement');
    return t.closest(movement ? '[data-move]' : '[data-slot]') as HTMLElement | null;
  }

  private dragOver(e: DragEvent): void {
    const el = this.dropTarget(e);
    if (!el) return;
    e.preventDefault(); // without this the drop never fires
    for (const x of this.el.querySelectorAll('.drop')) if (x !== el) x.classList.remove('drop');
    el.classList.add('drop');
  }

  private drop(e: DragEvent): void {
    const el = this.dropTarget(e);
    const d = this.dragging;
    this.dragging = null;
    if (!el || !d) return;
    e.preventDefault();
    if (el.dataset.slot !== undefined) {
      const to = Number(el.dataset.slot);
      if (d.slot !== undefined) this.change(swapSlots(this.build, d.slot, to), `Slots ${d.slot + 1} and ${to + 1} swapped.`);
      else if (d.book !== undefined) this.slotAbility(d.book, to);
    } else {
      const to = Number(el.dataset.move);
      if (d.move !== undefined) {
        const m = this.build.movement[d.move];
        this.change(assignMovement(this.build, to, m), `${movementName(m)} → ${MOVE_KEYS[to]}.`);
      } else if (d.book !== undefined) this.bindMovement(d.book, to);
    }
  }

  // ---------- Controller and keys ----------

  private rows(): Row[] {
    return [
      ...BOOK_GROUPS.map((g) => ({ kind: 'book' as const, items: bookEntries(g.kind).map((x) => x.i) })),
      { kind: 'slot' as const, items: Array.from({ length: HOTBAR_SLOTS }, (_, i) => i) },
      { kind: 'move' as const, items: Array.from({ length: MOVEMENT_SLOTS }, (_, i) => i) },
    ];
  }

  menu(press: MenuPress): void {
    if (this.assigning !== null && (press === 'back' || press === 'toggle')) return this.cancelAssign();
    const rows = this.rows();
    const row = rows[this.focus.row] ?? rows[0];
    const item = row.items[Math.min(this.focus.col, row.items.length - 1)];
    if (press === 'select') {
      this.showFocus = true;
      if (row.kind === 'book') {
        if (BOOK[item].kind === 'weapon' && this.known(item)) this.equip(item);
        this.select(item);
      } else if (row.kind === 'slot') this.clickSlot(item);
      else this.clickMove(item);
      return;
    }
    if (press === 'reset') {
      // Y: place the focused ability with a trigger and a face button, or bind a movement skill to
      // the next free key.
      this.showFocus = true;
      if (row.kind !== 'book') return;
      const s = BOOK[item];
      if (s.kind === 'ability') return this.startAssign(item);
      if (s.kind === 'movement' && this.known(item) && !MOVEMENT_SKILLS[s.index]?.builtin) {
        const at = this.build.movement.indexOf(s.index);
        const next = at < 0 ? Math.max(0, this.build.movement.indexOf(NO_MOVEMENT)) : at + 1;
        if (next >= MOVEMENT_SLOTS) return this.change(assignMovement(this.build, at, NO_MOVEMENT), `${bookName(s)} unbound.`);
        return this.bindMovement(item, next);
      }
      return;
    }
    if (press === 'up' || press === 'down') {
      const to = (this.focus.row + (press === 'down' ? 1 : rows.length - 1)) % rows.length;
      this.focus = { row: to, col: Math.min(this.focus.col, rows[to].items.length - 1) };
    } else if (press === 'left' || press === 'right') {
      const n = row.items.length;
      this.focus = { row: this.focus.row, col: (this.focus.col + (press === 'right' ? 1 : n - 1)) % n };
    } else return;
    this.showFocus = true;
    const now = rows[this.focus.row];
    if (now.kind === 'book') this.selected = now.items[this.focus.col];
    this.render();
  }

  /** Testing: put the cursor on a skill (by id) or a slot. */
  setFocus(where: { book?: string; slot?: number; move?: number }): void {
    const rows = this.rows();
    if (where.book !== undefined) {
      const b = BOOK.findIndex((x) => x.id === where.book);
      const r = rows.findIndex((x) => x.kind === 'book' && x.items.includes(b));
      if (r >= 0) this.focus = { row: r, col: rows[r].items.indexOf(b) };
      if (b >= 0) this.selected = b;
    } else if (where.slot !== undefined) this.focus = { row: rows.findIndex((x) => x.kind === 'slot'), col: where.slot };
    else if (where.move !== undefined) this.focus = { row: rows.findIndex((x) => x.kind === 'move'), col: where.move };
    this.showFocus = true;
    this.render();
  }

  // ---------- Drawing ----------

  render(): void {
    const b = this.build;
    const levels = this.ctx.levels();
    const xp = this.ctx.xp();
    const rows = this.rows();
    const focused = (kind: Row['kind'], i: number) => {
      const r = rows[this.focus.row];
      return this.showFocus && r?.kind === kind && r.items[this.focus.col] === i ? ' focus' : '';
    };
    const tile = (i: number) => {
      const s = BOOK[i];
      const known = this.known(i);
      const lv = levels[i] ?? 1;
      const p = levelProgress(xp[s.id] ?? 0, lv);
      const inHand = s.kind === 'weapon' && b.weapon === s.index;
      return `<button class="sk${i === this.selected ? ' sel' : ''}${known ? '' : ' locked'}${inHand ? ' held' : ''}${focused('book', i)}" data-book="${i}" draggable="${known && s.kind !== 'weapon'}" style="--c:${treeColor(bookTree(s))}">
        <span class="tile">${iconHtml(bookIcon(s), undefined, 36)}${known ? `<span class="lv">${lv}</span>` : ''}</span>
        ${known ? `<span class="xp"><i style="width:${p.max ? 100 : Math.round((p.have / p.need) * 100)}%"></i></span>` : `<span class="lock">${uiIcon('lock', 20)}</span>`}
        <span class="nm">${esc(bookName(s))}</span></button>`;
    };
    const groups = BOOK_GROUPS.map((g) => `<div class="sb-group">${g.title}</div><div class="sb-grid">${bookEntries(g.kind).map((x) => tile(x.i)).join('')}</div>`).join('');
    const left = this.ctx.budget() - skillCount(b.skills);
    const pad = this.ctx.device() === 'gamepad';
    const points = `<button class="sb-pts" data-act="tree">${uiIcon('star', 22)}<span>${
      left > 0 ? `<b>${left}</b> Skill Point${left === 1 ? '' : 's'} to Spend in the Tree` : 'Open the Skill Tree'
    }</span><span class="key">${pad ? 'RB' : 'N'}</span></button>`;

    const slot = (i: number) => {
      const a = b.abilities[i];
      const s = a === NO_ABILITY ? null : BOOK.find((x) => x.kind === 'ability' && x.index === a)!;
      return `<button class="hs${s ? ' on' : ''}${focused('slot', i)}" data-slot="${i}" draggable="${!!s}" style="--c:${s ? treeColor(bookTree(s)) : '#000'}"${s ? ` data-tip="book:${s.id}"` : ''}>${s ? iconHtml(bookIcon(s), undefined, 30) : ''}<span class="k">${pad ? PAD_SLOT_LABELS[i] : KEY_SLOT_LABELS[i]}</span></button>`;
    };
    const move = (i: number) => {
      const m = b.movement[i];
      const s = m === NO_MOVEMENT ? null : BOOK.find((x) => x.kind === 'movement' && x.index === m)!;
      return `<button class="hs${s ? ' on' : ''}${focused('move', i)}" data-move="${i}" draggable="${!!s}" style="--c:${s ? treeColor(bookTree(s)) : '#000'}"${s ? ` data-tip="book:${s.id}"` : ''}>${s ? iconHtml(bookIcon(s), undefined, 30) : ''}<span class="k">${pad ? PAD_MOVE_KEYS[i] : MOVE_KEYS[i]}</span></button>`;
    };
    const hint = this.assigning !== null ? 'Hold a trigger and press a face button' : pad ? 'Y puts the selected skill on a slot' : 'Drag skills onto slots · right-click a slot to clear it';

    this.el.innerHTML = `<div class="sb-dim"></div>
      <div class="sb">
        <div class="sb-cover"></div>
        <div class="sb-tabs">
          <button class="sb-tab on" data-tip="text:Skill Book" aria-label="Skill Book">${uiIcon('book', 24)}</button>
          <button class="sb-tab tree" data-act="tree" data-tip="text:Skill Tree (${pad ? 'RB' : 'N'})" aria-label="Skill Tree">${uiIcon('star', 24)}</button>
        </div>
        <div class="sb-page l">
          <h2>Skill Book</h2>
          <div class="sub">The skills you know. Each one gets better as you use it.</div>
          ${groups}
          ${points}
        </div>
        <div class="sb-spine"></div>
        <div class="sb-page r">${this.page(this.selected)}</div>
        <div class="sb-ribbon"></div>
        <button class="mw-x sb-x" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="sb-bar">
        <span class="lab">Hotbar</span><div class="slots">${Array.from({ length: HOTBAR_SLOTS }, (_, i) => slot(i)).join('')}</div>
        <span class="sep"></span>
        <span class="lab">Move</span><div class="slots">${Array.from({ length: MOVEMENT_SLOTS }, (_, i) => move(i)).join('')}</div>
        <span class="hint">${hint}</span>
      </div>
      <div class="sb-note${this.note ? '' : ' empty'}">${esc(this.note)}</div>`;
    this.el.querySelector('.sk.focus, .hs.focus')?.scrollIntoView?.({ block: 'nearest' });
  }

  /** The right-hand page: everything about one skill. */
  private page(i: number): string {
    const s = BOOK[i];
    if (!s) return '';
    const b = this.build;
    const known = this.known(i);
    const levels = this.ctx.levels();
    const lv = levels[i] ?? 1;
    const xp = this.ctx.xp()[s.id] ?? 0;
    const r = resolveSkills(b.skills, levels);
    const head = `<div class="sd-lv">${known ? `Level ${lv}` : 'Not Learned'}</div><h3 class="sd-name">${esc(bookName(s))}</h3><div class="sd-type">${esc(bookType(s))}</div><p class="sd-desc">${esc(bookDesc(s))}</p>`;
    if (!known) {
      const n = NODES[grantingNode(s)];
      return `${head}<div class="sd-stats locked"><p>Learn <b>${esc(n?.name ?? bookName(s))}</b> in the skill tree to use it. Skill points come from quests and milestones.</p></div>
        <div class="sd-btns"><button class="lui-btn gold" data-act="find">Find in the Tree</button></div>`;
    }
    const stats = bookStats(s, r);
    const next = lv < MAX_LEVEL ? bookStats(s, resolveSkills(b.skills, levelsWithNext(levels, i))) : stats;
    const changed = next.filter(([k, v]) => stats.find(([k2]) => k2 === k)?.[1] !== v);
    const p = levelProgress(xp, lv);
    const exp = p.max
      ? `<div class="sd-xp"><div class="r"><span>Experience</span><b>Mastered</b></div><div class="q-bar"><i style="width:100%"></i></div></div>`
      : `<div class="sd-xp"><div class="r"><span>Experience</span><b>${p.have} / ${p.need} ${xpUnit(s)}</b></div><div class="q-bar"><i style="width:${Math.round((p.have / p.need) * 100)}%"></i></div>
          <div class="nx">Level ${lv + 1}: <b>${changed.length ? esc(changed.map(([k, v]) => `${k} ${v}`).join(', ')) : 'a little better'}</b> · it grows each time you use it</div></div>`;
    // What the tree has done to it: every learned skill, notable or keystone that reaches it.
    const ctx = bookContext(s);
    const ups: string[] = [];
    let smalls = 0;
    NODES.forEach((n, j) => {
      if (j === grantingNode(s) || !hasSkill(b.skills, j)) return;
      const lines = (n.mods ?? []).filter((m) => modApplies(m, ctx)).map(describeMod);
      if (n.grants?.combo && s.kind === 'weapon' && combosFor(s).includes(n.grants.combo)) lines.unshift(n.desc ?? n.name);
      if (!lines.length) return;
      if (n.kind === 'small') smalls++;
      else ups.push(`<li><b>${esc(n.name)}:</b> ${esc(lines.join('; '))}</li>`);
    });
    if (smalls) ups.push(`<li>${smalls} passive${smalls === 1 ? '' : 's'} in the tree</li>`);
    let btns = '';
    if (s.kind === 'weapon') {
      btns = b.weapon === s.index ? `<button class="lui-btn" disabled>In Your Hands</button>` : `<button class="lui-btn gold" data-act="equip">Equip</button>`;
    } else if (s.kind === 'ability') {
      const at = b.abilities.indexOf(s.index);
      btns =
        at >= 0
          ? `<button class="lui-btn" data-act="clear">Clear Slot</button><button class="lui-btn gold" disabled>On Hotbar · Slot ${at + 1}</button>`
          : `<button class="lui-btn gold" data-act="slot">Put on Hotbar</button>`;
    } else if (MOVEMENT_SKILLS[s.index]?.builtin) {
      btns = `<button class="lui-btn" disabled>Always Ready · C, or B on a Controller</button>`;
    } else {
      const at = b.movement.indexOf(s.index);
      btns = MOVE_KEYS.map((k, m) => `<button class="lui-btn${at === m ? ' gold' : ''}" data-act="bind${m}"${at === m ? ' disabled' : ''}>${at === m ? `On ${k}` : `Bind to ${k}`}</button>`).join('');
      if (at >= 0) btns = `<button class="lui-btn" data-act="clear">Unbind</button>` + btns;
    }
    return `${head}<div class="sd-stats">${stats.map(([k, v]) => `<div class="r"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>${exp}
      ${ups.length ? `<ul class="sd-mods">${ups.join('')}</ul>` : ''}<div class="sd-btns">${btns}</div>`;
  }
}

/** The combo variants a weapon can take. */
const combosFor = (s: BookSkill): string[] => (WEAPONS[s.index]?.variants ?? []).map((v) => v.id);
