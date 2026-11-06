import type { MenuPress } from '../../input/input';
import { BOOK, NODES } from '../../skills';
import type { Build } from '../../tuning';
import { addTipSource, hideTip, wireTips } from '../theme/tooltip';
import { SkillBook } from './book';
import { esc, type SkillsContext } from './context';
import { bookName, levelProgress, xpUnit } from './describe';
import { SkillTreeView } from './tree';

// Skills: the book (what you know, its levels, your hotbar) and the tree (what you can learn). One
// of them is open at a time, over the game; T opens the book, N the tree, and on a controller View
// opens the book and a bumper switches between them.

export type SkillsView = 'book' | 'tree';

export class SkillsPanel {
  isOpen = false;
  view: SkillsView = 'book';
  onChange: ((b: Build) => void) | null = null;
  private root = document.getElementById('skills') as HTMLDivElement;
  private book: SkillBook;
  private tree: SkillTreeView;
  private build: Build;
  private frames = 0;
  /** The tree was opened from the book, so backing out of it goes back there. */
  private treeFromBook = false;

  constructor(build: Build, ctx: Omit<SkillsContext, 'build' | 'change'>) {
    this.build = build;
    const full: SkillsContext = {
      ...ctx,
      build: () => this.build,
      change: (b) => {
        this.build = b;
        this.onChange?.(b);
      },
    };
    this.book = new SkillBook(full, { openTree: (node) => this.open('tree', node), close: () => this.close() });
    this.tree = new SkillTreeView(full, {
      book: () => this.open('book'),
      back: () => (this.treeFromBook ? this.open('book') : this.close()),
      close: () => this.close(),
    });
    this.root.innerHTML = '';
    this.root.append(this.book.el, this.tree.el);
    wireTips();
    addTipSource((tip) => {
      if (tip.startsWith('node:')) return this.tree.tip(Number(tip.slice(5)));
      if (tip.startsWith('book:')) {
        const b = BOOK.findIndex((x) => x.id === tip.slice(5));
        if (b < 0) return null;
        const lv = full.levels()[b] ?? 1;
        const p = levelProgress(full.xp()[BOOK[b].id] ?? 0, lv);
        return `<h5>${esc(bookName(BOOK[b]))}</h5><div class="ty">Level ${lv}</div><div class="row"><span class="muted">Experience</span><b>${p.max ? 'Mastered' : `${p.have} / ${p.need} ${xpUnit(BOOK[b])}`}</b></div>`;
      }
      if (tip.startsWith('text:')) return `<p>${esc(tip.slice(5))}</p>`;
      return null;
    });
  }

  get current(): Build {
    return this.build;
  }

  setBuild(b: Build): void {
    this.build = b;
    if (this.isOpen) this.render();
  }

  open(view: SkillsView = 'book', node = -1): void {
    const was = this.isOpen ? this.view : null;
    if (view === 'tree' && was !== 'tree') this.treeFromBook = was === 'book';
    this.isOpen = true;
    this.view = view;
    this.root.hidden = false;
    this.root.dataset.view = view;
    if (document.pointerLockElement) document.exitPointerLock();
    hideTip();
    if (view === 'book') {
      if (was !== 'book') this.book.open();
      else this.book.render();
    } else this.tree.open(node);
    this.book.el.hidden = view !== 'book';
    this.tree.el.hidden = view !== 'tree';
  }

  close(): void {
    this.isOpen = false;
    this.book.assigning = null;
    this.root.hidden = true;
    hideTip();
  }

  toggle(view: SkillsView = 'book'): void {
    if (this.isOpen && this.view === view) this.close();
    else this.open(view);
  }

  render(): void {
    if (this.view === 'book') this.book.render();
    else this.tree.render();
  }

  /** Once a frame while open: the face in the tree's middle arrives after it's asked for. */
  tick(): void {
    if (!this.isOpen || this.view !== 'tree') return;
    if (++this.frames % 20 === 0) this.tree.refresh();
  }

  menu(press: MenuPress): void {
    if (this.view === 'book') {
      if (press === 'tab' || press === 'tree') return this.open('tree');
      if ((press === 'back' || press === 'toggle') && this.book.assigning === null) return this.close();
      return this.book.menu(press);
    }
    return this.tree.menu(press);
  }

  // ---------- The controller's hotbar placement ----------

  get isAssigning(): boolean {
    return this.isOpen && this.view === 'book' && this.book.assigning !== null;
  }

  assignToSlot(slot: number): boolean {
    return this.book.assignToSlot(slot);
  }

  // ---------- Testing ----------

  /** Puts the book's cursor on a skill (by id) or a slot, or the tree's on a node. */
  setFocus(where: { book?: string; slot?: number; move?: number; node?: string }): void {
    if (where.node !== undefined) this.tree.setFocus(where.node);
    else this.book.setFocus(where);
  }

  /** What the panel shows: for tests and bug reports. */
  state(): { open: boolean; view: SkillsView; selected: string; assigning: boolean; plan: string[]; focus: string | null } {
    const t = this.tree.state();
    return { open: this.isOpen, view: this.view, selected: BOOK[this.book.selected]?.id ?? '', assigning: this.isAssigning, plan: t.plan, focus: t.focus };
  }

  /** Testing: plan the way to a node and learn it, as clicking it and Learn would. */
  learnNode(id: string): boolean {
    if (!NODES.some((n) => n.id === id)) return false;
    if (!this.isOpen || this.view !== 'tree') this.open('tree');
    const before = this.build;
    this.tree.planNode(id);
    this.tree.learnPlan();
    return this.build !== before;
  }

  selectBook(id: string): void {
    const b = BOOK.findIndex((x) => x.id === id);
    if (b < 0) return;
    if (!this.isOpen || this.view !== 'book') this.open('book');
    this.book.select(b);
  }
}
