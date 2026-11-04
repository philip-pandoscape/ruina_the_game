import {
  abilityName,
  alsoDropped,
  assignMovement,
  assignSlot,
  cycleMovement,
  cycleSlot,
  movementName,
  has,
  learn,
  learnBlock,
  NODE_INFO,
  pointsLeft,
  rowOf,
  swapSlots,
  unlearn,
  unlearnBlock,
  weaponsOf,
  type NodeInfo,
} from '../build';
import type { MenuPress } from '../input/input';
import { ABILITIES, DEFAULT_BUILD, HOTBAR_SLOTS, MOVEMENT_SKILLS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT, SKILLS, type Build } from '../tuning';
import { ABILITY_ICONS, SKILL_ICONS, TREE_COLORS, WEAPON_ICONS, WEAPON_NAMES } from './icons';

// The skill panel: spend points down four trees, then pick a weapon and fill the hotbar from what
// you've learned. Mouse: click to learn, click again or right-click to unlearn, and drag abilities
// onto the bar. Keyboard: arrows, Enter, Esc. Controller: D-pad or stick, A to choose, B to close.
// Y on an ability starts hotbar assignment: the next trigger + face button puts it in that slot.

// The deepest column decides how many rows the grid has; trees no longer have to be equal.
const ROWS = Math.max(1, ...NODE_INFO.map((n) => rowOf(n) + 1));
const WEAPON_ROW = ROWS; // the four weapons
const HOTBAR_ROW = ROWS + 1; // the eight hotbar slots
const MOVEMENT_ROW = ROWS + 2; // the Q / E movement slots
const WEAPON_COLS = 4;

// Matches the pad bindings in input.ts: LT gives slots 1-4 and RT slots 5-8.
const PAD_SLOT_LABELS = ['LT+A', 'LT+B', 'LT+X', 'LT+Y', 'RT+A', 'RT+B', 'RT+X', 'RT+Y'];
const MOVEMENT_BINDS = ['Q', 'E'];
const PAD_MOVE_LABELS = ['LB', 'RB'];

// The node drawn at a given column and row of the grid.
const nodeAtCell = (tree: number, row: number): NodeInfo | undefined => NODE_INFO.filter((n) => n.tree === tree).at(row);

export class SkillTreePanel {
  isOpen = false;
  onChange: ((b: Build) => void) | null = null;
  private root = document.getElementById('skills') as HTMLDivElement;
  private build: Build;
  private focus = { row: 0, col: 0 };
  private showFocus = false; // only once the keyboard or controller moves the cursor
  private note = '';
  // Controller assignment: the ability waiting to be put somewhere, or null.
  private assigning: number | null = null;
  private dragging: { ability: number; fromSlot: number } | null = null;

  constructor(build: Build) {
    this.build = build;
    this.root.addEventListener('click', (e) => this.click(e, false));
    this.root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.click(e, true);
    });
    // Clicking the dark backdrop closes the panel.
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener('dragstart', (e) => this.dragStart(e));
    this.root.addEventListener('dragover', (e) => this.dragOver(e));
    this.root.addEventListener('drop', (e) => this.drop(e));
    this.root.addEventListener('dragend', () => {
      this.dragging = null;
      for (const el of this.root.querySelectorAll('.over')) el.classList.remove('over');
    });
  }

  get current(): Build {
    return this.build;
  }

  setBuild(b: Build): void {
    this.build = b;
    if (this.isOpen) this.render();
  }

  open(): void {
    this.isOpen = true;
    this.note = '';
    this.root.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.render();
  }

  close(): void {
    this.isOpen = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private colsIn(row: number): number {
    if (row === HOTBAR_ROW) return HOTBAR_SLOTS;
    if (row === MOVEMENT_ROW) return MOVEMENT_SLOTS;
    if (row === WEAPON_ROW) return WEAPON_COLS;
    return SKILLS.trees.length;
  }

  menu(press: MenuPress): void {
    // While waiting for a slot, B backs out and anything else is handled by assignToSlot().
    if (this.assigning !== null && (press === 'back' || press === 'toggle')) return this.cancelAssign();
    if (press === 'toggle' || press === 'back') return this.close();
    if (press === 'reset') {
      // Y starts hotbar assignment when an ability is focused, and otherwise resets the build.
      const ability = this.focusedAbility();
      if (ability !== null) return this.startAssign(ability);
      return this.change({ ...DEFAULT_BUILD, abilities: [...DEFAULT_BUILD.abilities] }, 'Back to the start: Sword Training only.');
    }
    if (press === 'select') {
      this.showFocus = true;
      return this.activate(this.focus.row, this.focus.col, false);
    }
    this.showFocus = true;
    const rows = MOVEMENT_ROW + 1;
    const cols = this.colsIn(this.focus.row);
    if (press === 'left') this.focus.col = (this.focus.col + cols - 1) % cols;
    if (press === 'right') this.focus.col = (this.focus.col + 1) % cols;
    if (press === 'up' || press === 'down') {
      const row = (this.focus.row + (press === 'down' ? 1 : rows - 1)) % rows;
      this.focus.col = Math.min(this.focus.col, this.colsIn(row) - 1);
      this.focus.row = row;
    }
    this.render();
  }

  // The ability under the cursor, whether that's a skill node or a filled hotbar slot.
  private focusedAbility(): number | null {
    if (this.focus.row < ROWS) {
      const info = nodeAtCell(this.focus.col, this.focus.row);
      const a = info?.node.grants?.ability;
      return a !== undefined && has(this.build, info!.index) ? a : null;
    }
    if (this.focus.row === HOTBAR_ROW) {
      const a = this.build.abilities[this.focus.col];
      return a === NO_ABILITY ? null : a;
    }
    return null;
  }

  private startAssign(ability: number): void {
    this.assigning = ability;
    this.note = `Assigning ${abilityName(ability)}: press a trigger and a face button (${PAD_SLOT_LABELS[0]}…), or B to cancel.`;
    this.render();
  }

  private cancelAssign(): void {
    this.assigning = null;
    this.note = 'Assignment cancelled.';
    this.render();
  }

  // Called from the game loop when a hotbar combination is pressed while the panel is open.
  // Returns true if it was used for assignment.
  assignToSlot(slot: number): boolean {
    if (this.assigning === null || slot < 1 || slot > HOTBAR_SLOTS) return false;
    const ability = this.assigning;
    this.assigning = null;
    this.change(assignSlot(this.build, slot - 1, ability), `${abilityName(ability)} → slot ${slot} (${PAD_SLOT_LABELS[slot - 1]}).`);
    return true;
  }

  get isAssigning(): boolean {
    return this.assigning !== null;
  }

  // Testing: put the cursor somewhere without having to walk it there with the D-pad.
  setFocus(row: number, col: number): void {
    this.showFocus = true;
    this.focus = { row, col };
    this.render();
  }

  // Dragging: either a learned ability out of a skill node, or an ability already on the bar.
  private dragStart(e: DragEvent): void {
    const el = (e.target as HTMLElement).closest('[data-row]') as HTMLElement | null;
    if (!el) return;
    const row = Number(el.dataset.row);
    const col = Number(el.dataset.col);
    let ability: number | null = null;
    let fromSlot = -1;
    if (row === HOTBAR_ROW) {
      ability = this.build.abilities[col];
      fromSlot = col;
      if (ability === NO_ABILITY) ability = null;
    } else if (row < ROWS) {
      const info = nodeAtCell(col, row);
      const a = info?.node.grants?.ability;
      if (a !== undefined && has(this.build, info!.index)) ability = a;
    }
    if (ability === null) {
      e.preventDefault();
      return;
    }
    this.dragging = { ability, fromSlot };
    e.dataTransfer?.setData('text/plain', String(ability));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  private dragOver(e: DragEvent): void {
    if (!this.dragging) return;
    const el = (e.target as HTMLElement).closest('.hslot') as HTMLElement | null;
    if (!el) return;
    e.preventDefault(); // without this the drop never fires
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    for (const other of this.root.querySelectorAll('.over')) other.classList.remove('over');
    el.classList.add('over');
  }

  private drop(e: DragEvent): void {
    const drag = this.dragging;
    this.dragging = null;
    if (!drag) return;
    const el = (e.target as HTMLElement).closest('.hslot') as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    const to = Number(el.dataset.col);
    // Dragging between slots swaps them; dragging in from a skill moves the ability there.
    const next = drag.fromSlot >= 0 ? swapSlots(this.build, drag.fromSlot, to) : assignSlot(this.build, to, drag.ability);
    this.change(next, `${abilityName(drag.ability)} → slot ${to + 1}.`);
  }

  private click(e: MouseEvent, unlearnOnly: boolean): void {
    const el = (e.target as HTMLElement).closest('[data-row]') as HTMLElement | null;
    const act = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (act?.dataset.act === 'close') return this.close();
    if (act?.dataset.act === 'reset') return this.change({ ...DEFAULT_BUILD }, 'Back to the start: Sword Training only.');
    if (!el) return;
    this.showFocus = false;
    this.focus = { row: Number(el.dataset.row), col: Number(el.dataset.col) };
    this.activate(this.focus.row, this.focus.col, unlearnOnly);
  }

  private activate(row: number, col: number, unlearnOnly: boolean): void {
    const b = this.build;
    if (row < ROWS) {
      const info = nodeAtCell(col, row)!;
      if (has(b, info.index)) {
        const block = unlearnBlock(b, info);
        if (block) return this.say(block);
        const also = alsoDropped(b, info);
        return this.change(unlearn(b, info), `Unlearned ${info.node.name}${also ? ` and ${also} that needed it` : ''}.`);
      }
      if (unlearnOnly) return this.say(`${info.node.name} isn't learned.`);
      const block = learnBlock(b, info);
      if (block) return this.say(block);
      return this.change(learn(b, info), `Learned ${info.node.name}!`);
    }
    if (unlearnOnly) {
      // Right-clicking a slot empties it.
      if (row === HOTBAR_ROW && b.abilities[col] !== NO_ABILITY) {
        return this.change(assignSlot(b, col, NO_ABILITY), `Slot ${col + 1} cleared.`);
      }
      if (row === MOVEMENT_ROW && b.movement[col] !== NO_MOVEMENT) {
        return this.change(assignMovement(b, col, NO_MOVEMENT), `${MOVEMENT_BINDS[col]} cleared.`);
      }
      return;
    }
    if (row === MOVEMENT_ROW) {
      const next = cycleMovement(b, col);
      const m = next.movement[col];
      if (m === b.movement[col] && m === NO_MOVEMENT) return this.say('Learn a movement skill to fill this slot.');
      return this.change(next, `${MOVEMENT_BINDS[col]}: ${movementName(m)}.`);
    }
    if (row === WEAPON_ROW) {
      if (!weaponsOf(b.skills).includes(col)) {
        const node = NODE_INFO.find((n) => n.node.grants?.weapon === col)!;
        return this.say(`Learn ${node.node.name} to use the ${WEAPON_NAMES[col].toLowerCase()}.`);
      }
      return this.change({ ...b, weapon: col }, `${WEAPON_NAMES[col]} equipped.`);
    }
    const next = cycleSlot(b, col);
    const a = next.abilities[col];
    if (a === b.abilities[col] && a === NO_ABILITY) return this.say('Learn Healing Circle or Meteor to fill a slot.');
    this.change(next, `Slot ${col + 1}: ${abilityName(a)}.`);
  }

  private change(b: Build, note: string): void {
    this.build = b;
    this.note = note;
    this.onChange?.(b);
    this.render();
  }

  private say(note: string): void {
    this.note = note;
    this.render();
  }

  private render(): void {
    if (!this.isOpen) return;
    const b = this.build;
    const left = pointsLeft(b.skills);
    const focused = (row: number, col: number) => (this.showFocus && this.focus.row === row && this.focus.col === col ? ' focus' : '');

    const node = (info: NodeInfo) => {
      const learned = has(b, info.index);
      const state = learned ? 'learned' : learnBlock(b, info) ? 'locked' : 'available';
      // The grid row is the node's place in its own column, not its index in the whole tree:
      // those are the same only while every column is the same length.
      const row = rowOf(info);
      const icon = info.node.icon || SKILL_ICONS[info.node.id] || '★';
      return `<button class="node ${state}${focused(row, info.tree)}" data-row="${row}" data-col="${info.tree}" data-skill="${info.node.id}">
        <span class="icon">${icon}</span>
        <span><b>${info.node.name}</b><small>${info.node.desc}</small></span></button>`;
    };
    const trees = SKILLS.trees
      .map((tree, t) => {
        const nodes = NODE_INFO.filter((n) => n.tree === t);
        const parts = nodes.map((n, i) => (i ? `<div class="link${has(b, n.index) ? ' on' : ''}"></div>` : '') + node(n));
        return `<section class="tree" style="--c:${TREE_COLORS[t]}"><h3>${tree.name}</h3>${parts.join('')}</section>`;
      })
      .join('');

    const trained = weaponsOf(b.skills);
    const weapons = WEAPON_NAMES.map(
      (name, w) =>
        `<button class="choice${b.weapon === w ? ' on' : ''}${trained.includes(w) ? '' : ' off'}${focused(WEAPON_ROW, w)}" data-row="${WEAPON_ROW}" data-col="${w}" data-weapon="${w}">${WEAPON_ICONS[w]} ${name}</button>`,
    ).join('');
    const slot = (i: number) => {
      const a = b.abilities[i];
      const filled = a !== NO_ABILITY;
      return `<button class="hslot${filled ? ' on' : ' off'}${focused(HOTBAR_ROW, i)}${this.assigning !== null ? ' awaiting' : ''}"
        data-row="${HOTBAR_ROW}" data-col="${i}" data-slot="${i}" draggable="${filled}"
        title="${filled ? ABILITIES[a].name : 'Empty'} — drag an ability here, or click to cycle">
        <span class="n">${i + 1}</span><span class="icon">${filled ? ABILITY_ICONS[a] : '·'}</span>
        <span class="pad">${PAD_SLOT_LABELS[i]}</span></button>`;
    };
    const hotbar = Array.from({ length: HOTBAR_SLOTS }, (_, i) => slot(i)).join('');
    const moveSlot = (i: number) => {
      const m = b.movement[i];
      const filled = m !== NO_MOVEMENT;
      return `<button class="hslot${filled ? ' on' : ' off'}${focused(MOVEMENT_ROW, i)}"
        data-row="${MOVEMENT_ROW}" data-col="${i}" title="${filled ? MOVEMENT_SKILLS[m].desc : 'Empty'}">
        <span class="n">${MOVEMENT_BINDS[i]}</span><span class="icon">${filled ? MOVEMENT_SKILLS[m].icon : '\u00b7'}</span>
        <span class="pad">${PAD_MOVE_LABELS[i]}</span></button>`;
    };
    const movementBar = Array.from({ length: MOVEMENT_SLOTS }, (_, i) => moveSlot(i)).join('');

    this.root.innerHTML = `<div class="panel">
      <header><h2>Skills</h2><div class="points"><b>${left}</b> / ${SKILLS.points} points left</div>
        <button class="hbtn" data-act="reset">Start over</button><button class="hbtn" data-act="close">Close ✕</button></header>
      <div class="trees">${trees}</div>
      <div class="loadout">
        <div><h4>Weapon</h4><div class="choices">${weapons}</div></div>
        <div><h4>Hotbar <small>drag an ability onto a slot, or click a slot to cycle</small></h4>
          <div class="hotbar${this.assigning !== null ? ' assigning' : ''}">${hotbar}</div></div>
        <div><h4>Movement <small>click to cycle</small></h4><div class="hotbar">${movementBar}</div></div>
      </div>
      <footer>${
        this.note
          ? `<span class="note">${this.note}</span>`
          : 'Click a skill to learn it; click it again or right-click to unlearn. Drag abilities onto the hotbar, or press Y on one with a controller.'
      }</footer>
    </div>`;
  }
}
