import { abilityName, cycleSlot, has, learn, learnBlock, NODES, pointsLeft, unlearn, unlearnBlock, weaponsOf, type NodeInfo } from '../build';
import type { MenuPress } from '../input/input';
import { ABILITIES, DEFAULT_BUILD, NO_ABILITY, SKILLS, type Build } from '../tuning';
import { ABILITY_ICONS, SKILL_ICONS, TREE_COLORS, WEAPON_ICONS, WEAPON_NAMES } from './icons';

// The skill panel: spend points down four trees, then pick a weapon and two abilities from what
// you've learned. Mouse: click to learn, click again or right-click to unlearn. Keyboard: arrows,
// Enter, Esc. Controller: D-pad or stick, A to choose, B to close, Y to start over.

const ROWS = 3; // skills per tree
const LOADOUT_ROW = ROWS; // weapons (columns 0-3), then the two ability slots (4, 5)
const LOADOUT_COLS = 6;

export class SkillTreePanel {
  isOpen = false;
  onChange: ((b: Build) => void) | null = null;
  private root = document.getElementById('skills') as HTMLDivElement;
  private build: Build;
  private focus = { row: 0, col: 0 };
  private showFocus = false; // only once the keyboard or controller moves the cursor
  private note = '';

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

  menu(press: MenuPress): void {
    if (press === 'toggle' || press === 'back') return this.close();
    if (press === 'reset') return this.change({ ...DEFAULT_BUILD }, 'Back to the start: Sword Training only.');
    if (press === 'select') {
      this.showFocus = true;
      return this.activate(this.focus.row, this.focus.col, false);
    }
    this.showFocus = true;
    const cols = this.focus.row === LOADOUT_ROW ? LOADOUT_COLS : SKILLS.trees.length;
    if (press === 'left') this.focus.col = (this.focus.col + cols - 1) % cols;
    if (press === 'right') this.focus.col = (this.focus.col + 1) % cols;
    if (press === 'up' || press === 'down') {
      const row = (this.focus.row + (press === 'down' ? 1 : ROWS)) % (ROWS + 1);
      // Keep roughly the same column between the trees and the loadout row.
      if (row === LOADOUT_ROW && this.focus.row !== LOADOUT_ROW) this.focus.col = Math.min(this.focus.col, LOADOUT_COLS - 1);
      if (row !== LOADOUT_ROW && this.focus.row === LOADOUT_ROW) this.focus.col = Math.min(this.focus.col, SKILLS.trees.length - 1);
      this.focus.row = row;
    }
    this.render();
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
      const info = NODES.find((n) => n.tree === col && n.index === row)!;
      if (has(b.perks, info.bit)) {
        const block = unlearnBlock(b.perks, info);
        if (block) return this.say(block);
        const below = NODES.filter((n) => n.tree === info.tree && n.index > info.index && has(b.perks, n.bit)).length;
        return this.change(unlearn(b, info), `Unlearned ${info.node.name}${below ? ' and the skills below it' : ''}.`);
      }
      if (unlearnOnly) return this.say(`${info.node.name} isn't learned.`);
      const block = learnBlock(b.perks, info);
      if (block) return this.say(block);
      return this.change(learn(b, info), `Learned ${info.node.name}!`);
    }
    if (unlearnOnly) return;
    if (col < 4) {
      if (!weaponsOf(b.perks).includes(col)) {
        const node = NODES.find((n) => n.node.weapon === col)!;
        return this.say(`Learn ${node.node.name} to use the ${WEAPON_NAMES[col].toLowerCase()}.`);
      }
      return this.change({ ...b, weapon: col }, `${WEAPON_NAMES[col]} equipped.`);
    }
    const slot = col === 4 ? 1 : 2;
    const next = cycleSlot(b, slot);
    const a = slot === 1 ? next.ability1 : next.ability2;
    if (a === (slot === 1 ? b.ability1 : b.ability2) && a === NO_ABILITY) return this.say('Learn Healing Circle or Meteor to fill this slot.');
    this.change(next, `Slot ${slot}: ${abilityName(a)}.`);
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
    const left = pointsLeft(b.perks);
    const focused = (row: number, col: number) => (this.showFocus && this.focus.row === row && this.focus.col === col ? ' focus' : '');

    const node = (info: NodeInfo) => {
      const learned = has(b.perks, info.bit);
      const state = learned ? 'learned' : learnBlock(b.perks, info) ? 'locked' : 'available';
      return `<button class="node ${state}${focused(info.index, info.tree)}" data-row="${info.index}" data-col="${info.tree}" data-skill="${info.node.id}">
        <span class="icon">${SKILL_ICONS[info.node.id] ?? '★'}</span>
        <span><b>${info.node.name}</b><small>${info.node.desc}</small></span></button>`;
    };
    const trees = SKILLS.trees
      .map((tree, t) => {
        const nodes = NODES.filter((n) => n.tree === t);
        const parts = nodes.map((n, i) => (i ? `<div class="link${has(b.perks, n.bit) ? ' on' : ''}"></div>` : '') + node(n));
        return `<section class="tree" style="--c:${TREE_COLORS[t]}"><h3>${tree.name}</h3>${parts.join('')}</section>`;
      })
      .join('');

    const trained = weaponsOf(b.perks);
    const weapons = WEAPON_NAMES.map(
      (name, w) =>
        `<button class="choice${b.weapon === w ? ' on' : ''}${trained.includes(w) ? '' : ' off'}${focused(LOADOUT_ROW, w)}" data-row="${LOADOUT_ROW}" data-col="${w}" data-weapon="${w}">${WEAPON_ICONS[w]} ${name}</button>`,
    ).join('');
    const slot = (s: 1 | 2) => {
      const a = s === 1 ? b.ability1 : b.ability2;
      const icon = a === NO_ABILITY ? '·' : ABILITY_ICONS[a];
      return `<button class="choice${a === NO_ABILITY ? ' off' : ' on'}${focused(LOADOUT_ROW, 3 + s)}" data-row="${LOADOUT_ROW}" data-col="${3 + s}" data-slot="${s}">
        <span class="k">${s === 1 ? 'E / Y' : 'Q / RB'}</span>${icon} ${a === NO_ABILITY ? 'Empty' : ABILITIES[a].name}</button>`;
    };

    this.root.innerHTML = `<div class="panel">
      <header><h2>Skills</h2><div class="points"><b>${left}</b> / ${SKILLS.points} points left</div>
        <button class="hbtn" data-act="reset">Start over</button><button class="hbtn" data-act="close">Close ✕</button></header>
      <div class="trees">${trees}</div>
      <div class="loadout">
        <div><h4>Weapon</h4><div class="choices">${weapons}</div></div>
        <div><h4>Abilities (click to change)</h4><div class="choices">${slot(1)}${slot(2)}</div></div>
      </div>
      <footer>${this.note ? `<span class="note">${this.note}</span>` : 'Click a skill to learn it; click it again or right-click to unlearn. Changes apply right away.'}</footer>
    </div>`;
  }
}
