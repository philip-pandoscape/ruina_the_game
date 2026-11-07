import { alsoDropped, learnBlock, learnPath, NODE_INFO, unlearn, unlearnBlock } from '../../content/build';
import { ADJACENT, hasSkill, LINKS, NODES, ORBITS, pathTo, reachable, ROOTS, skillCount, TREES, withSkill, type SkillSet } from '../../content/skills';
import type { MenuPress } from '../../input/input';
import { iconUrl } from '../theme/icons';
import { toUi, uiSize } from '../theme/scale';
import { hideTip, showTip } from '../theme/tooltip';
import { esc, type SkillsContext } from './context';
import { KIND_NAMES, nodeLines, treeColor, treeName } from './describe';

// The skill tree: a chart of everything you can learn, four disciplines around you. Hover a node to
// read it, click to plan the way to it, Learn to spend the points; right-click something learned to
// give it back. Drag to look around, the wheel to zoom. On a controller the D-pad walks from node to
// node, A plans, Y learns and B goes back to the book.

const MIDS = [-45, 45, 135, -135]; // where each discipline points (gen.mjs lays them out the same way)
const OUTER = ORBITS[ORBITS.length - 1];
const pos = (i: number) => {
  const n = NODES[i];
  const r = ORBITS[n.o] ?? 0;
  const a = (n.a * Math.PI) / 180;
  return { x: r * Math.sin(a), y: -r * Math.cos(a) };
};
const POS = NODES.map((_, i) => pos(i));
const fmt = (v: number) => v.toFixed(1);

export class SkillTreeView {
  readonly el = document.createElement('div');
  private world!: SVGGElement;
  /** Nodes to learn, nearest first. */
  private plan: number[] = [];
  private query = '';
  private focus = -1;
  private showFocus = false;
  private note = '';
  private confirmUnlearn = -1;
  private view = { s: 0.7, x: 0, y: 0 }; // zoom, and the screen point the tree's centre sits on
  private drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  private shownPortrait: string | null = null;

  constructor(
    private ctx: SkillsContext,
    private nav: { book(): void; back(): void; close(): void },
  ) {
    this.el.className = 'st';
    this.el.addEventListener('click', (e) => this.click(e));
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const i = this.nodeAt(e.target);
      if (i !== null) this.unlearn(i);
    });
    this.el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = toUi(e.clientX, e.clientY);
        this.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      },
      { passive: false },
    );
    this.el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !(e.target as Element).closest('svg.st-svg')) return;
      const p = toUi(e.clientX, e.clientY);
      this.drag = { x: p.x, y: p.y, vx: this.view.x, vy: this.view.y, moved: false };
    });
    addEventListener('mousemove', (e) => {
      if (!this.drag) return;
      const p = toUi(e.clientX, e.clientY);
      const dx = p.x - this.drag.x;
      const dy = p.y - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      if (!this.drag.moved) return;
      this.view.x = this.drag.vx + dx;
      this.view.y = this.drag.vy + dy;
      this.place();
    });
    addEventListener('mouseup', () => {
      // A drag that went somewhere isn't a click on whatever it ended over.
      if (this.drag?.moved) setTimeout(() => (this.drag = null));
      else this.drag = null;
    });
    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (!t.classList.contains('st-search')) return;
      this.query = t.value.trim().toLowerCase();
      this.renderNodes();
    });
    this.el.addEventListener('keydown', (e) => {
      const t = e.target as HTMLInputElement;
      if (!t.classList.contains('st-search')) return;
      e.stopPropagation(); // typing in the search box isn't playing
      if (e.key === 'Enter') {
        const hit = NODES.findIndex((_, i) => this.matches(i));
        if (hit >= 0) this.centerOn(hit, Math.max(this.view.s, 1.2));
      }
      if (e.key === 'Escape') t.blur();
    });
  }

  private get build() {
    return this.ctx.build();
  }

  private learned(): SkillSet {
    return this.build.skills;
  }

  /** What you'd have with the plan learned too. */
  private withPlan(): SkillSet {
    let s = this.learned();
    for (const i of this.plan) s = withSkill(s, i, true);
    return s;
  }

  get pointsLeft(): number {
    return this.ctx.budget() - skillCount(this.learned());
  }

  /** Opens on the whole tree, or close in on one node. */
  open(node = -1): void {
    this.plan = [];
    this.note = '';
    this.confirmUnlearn = -1;
    this.showFocus = this.ctx.device() === 'gamepad';
    this.build0();
    this.overview();
    const start = node >= 0 ? node : NODES.findIndex((_, i) => hasSkill(this.learned(), i));
    this.focus = start >= 0 ? start : (ROOTS[0] ?? 0);
    if (node >= 0) this.centerOn(node, 1.25);
    this.render();
  }

  private overview(): void {
    const { width, height } = uiSize();
    this.view = { s: Math.min(width, height - 110) / (2 * (OUTER + 130)), x: width / 2, y: height / 2 + 14 };
  }

  // ---------- Learning ----------

  private planTo(i: number): void {
    if (hasSkill(this.learned(), i)) return;
    if (this.plan.includes(i)) {
      // Taking a node out of the plan takes whatever only it led to.
      const rest = this.plan.filter((j) => j !== i);
      let s = this.learned();
      for (const j of rest) s = withSkill(s, j, true);
      const keep = connected(s);
      this.plan = rest.filter((j) => keep[j]);
      this.note = '';
      return this.render();
    }
    const path = pathTo(this.withPlan(), i);
    if (!path.length) return this.say('There is no way there from what you know.');
    this.plan.push(...path);
    this.note = '';
    this.render();
  }

  learnPlan(): void {
    if (!this.plan.length) return;
    const n = this.plan.length;
    if (n > this.pointsLeft)
      return this.say(`That needs ${n} point${n === 1 ? '' : 's'}; you have ${Math.max(0, this.pointsLeft)}. More come from quests and milestones.`);
    const next = learnPath(this.build, this.plan, this.ctx.budget());
    if (!next) return this.say(learnBlock(this.build, NODE_INFO[this.plan[0]], this.ctx.budget()) ?? 'That can’t be learned.');
    const names = this.plan.filter((i) => NODES[i].kind !== 'small').map((i) => NODES[i].name);
    this.plan = [];
    this.ctx.change(next, `Learned ${names.length ? names.join(', ') : `${n} passive${n === 1 ? '' : 's'}`}.`);
    this.note = '';
    this.render();
  }

  private unlearn(i: number): void {
    if (!hasSkill(this.learned(), i)) return;
    const info = NODE_INFO[i];
    const block = unlearnBlock(this.build, info);
    if (block) return this.say(block);
    const more = alsoDropped(this.build, info);
    this.ctx.change(unlearn(this.build, info), `${NODES[i].name} given back${more ? `, and ${more} that needed it` : ''}.`);
    this.plan = [];
    this.render();
  }

  private say(note: string): void {
    this.note = note;
    this.renderChrome();
  }

  // ---------- Input ----------

  private nodeAt(t: EventTarget | null): number | null {
    const g = (t as Element | null)?.closest?.('[data-n]');
    return g ? Number(g.getAttribute('data-n')) : null;
  }

  private click(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const act = (t.closest('[data-act]') as HTMLElement | null)?.dataset.act;
    if (act === 'close') return this.nav.close();
    if (act === 'book') return this.nav.book();
    if (act === 'learn') return this.learnPlan();
    if (act === 'undo') {
      this.plan = [];
      return this.render();
    }
    if (act === 'in' || act === 'out') {
      const { width, height } = uiSize();
      return this.zoomAt(width / 2, height / 2, act === 'in' ? 1.3 : 1 / 1.3);
    }
    if (act === 'fit') {
      this.overview();
      return this.place();
    }
    if (this.drag?.moved) return;
    const i = this.nodeAt(t);
    if (i === null) return;
    this.focus = i;
    this.showFocus = false;
    this.planTo(i);
  }

  menu(press: MenuPress): void {
    // B drops a plan first, then goes back where you came from.
    if (press === 'back') return this.plan.length ? ((this.plan = []), this.render()) : this.nav.back();
    if (press === 'tab') return this.nav.book();
    if (press === 'toggle' || press === 'tree') return this.nav.close();
    this.showFocus = true;
    if (press === 'select') {
      if (this.focus >= 0) this.planTo(this.focus);
      return;
    }
    if (press === 'reset') {
      if (this.plan.length) return this.learnPlan();
      if (this.focus >= 0 && hasSkill(this.learned(), this.focus)) {
        // Giving something back takes two presses.
        if (this.confirmUnlearn !== this.focus) {
          this.confirmUnlearn = this.focus;
          const more = alsoDropped(this.build, NODE_INFO[this.focus]);
          return this.say(`Press Y again to give back ${NODES[this.focus].name}${more ? ` and ${more} that need it` : ''}.`);
        }
        this.confirmUnlearn = -1;
        return this.unlearn(this.focus);
      }
      return;
    }
    const dir = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[press as 'up'];
    if (!dir) return;
    this.confirmUnlearn = -1;
    this.focus = nextNode(this.focus, dir[0], dir[1]);
    this.keepInView(this.focus);
    this.renderNodes();
    this.tipFocus();
  }

  /** Testing: what's planned and focused. */
  state(): { plan: string[]; focus: string | null; query: string } {
    return { plan: this.plan.map((i) => NODES[i].id), focus: this.focus >= 0 ? NODES[this.focus].id : null, query: this.query };
  }

  /** Testing: plan the way to a node, as a click would. */
  planNode(id: string): void {
    const i = NODES.findIndex((n) => n.id === id);
    if (i >= 0) this.planTo(i);
  }

  setFocus(id: string): void {
    const i = NODES.findIndex((n) => n.id === id);
    if (i < 0) return;
    this.focus = i;
    this.showFocus = true;
    this.keepInView(i);
    this.renderNodes();
  }

  // ---------- View ----------

  private zoomAt(x: number, y: number, k: number): void {
    const { width, height } = uiSize();
    const min = (Math.min(width, height - 110) / (2 * (OUTER + 130))) * 0.85;
    const s = Math.max(min, Math.min(2.6, this.view.s * k));
    // Keep the point under the cursor where it is.
    this.view.x = x - ((x - this.view.x) * s) / this.view.s;
    this.view.y = y - ((y - this.view.y) * s) / this.view.s;
    this.view.s = s;
    this.place();
  }

  private centerOn(i: number, s = this.view.s): void {
    const { width, height } = uiSize();
    this.view.s = s;
    this.view.x = width / 2 - POS[i].x * s;
    this.view.y = height / 2 - POS[i].y * s;
    this.place();
  }

  private keepInView(i: number): void {
    const { width, height } = uiSize();
    const x = this.view.x + POS[i].x * this.view.s;
    const y = this.view.y + POS[i].y * this.view.s;
    if (x < width * 0.2 || x > width * 0.8 || y < height * 0.22 || y > height * 0.8) this.centerOn(i, Math.max(this.view.s, 1.05));
  }

  /** Moves the chart to the current pan and zoom, and the minimap's box with it. */
  private place(): void {
    if (!this.world) return;
    this.world.setAttribute('transform', `translate(${fmt(this.view.x)} ${fmt(this.view.y)}) scale(${this.view.s.toFixed(4)})`);
    const { width, height } = uiSize();
    const mini = this.el.querySelector('.st-mini') as HTMLElement | null;
    const box = this.el.querySelector('.st-mini rect') as SVGRectElement | null;
    const zoomed = this.view.s > (Math.min(width, height - 110) / (2 * (OUTER + 130))) * 1.15;
    if (mini) mini.hidden = !zoomed;
    if (box) {
      const k = MINI / (2 * (OUTER + 40));
      box.setAttribute('x', fmt(MINI / 2 + (-this.view.x / this.view.s) * k));
      box.setAttribute('y', fmt(MINI / 2 + (-this.view.y / this.view.s) * k));
      box.setAttribute('width', fmt((width / this.view.s) * k));
      box.setAttribute('height', fmt((height / this.view.s) * k));
    }
    if (this.showFocus) this.tipFocus();
  }

  private tipFocus(): void {
    const g = this.focus >= 0 ? this.el.querySelector(`[data-n="${this.focus}"]`) : null;
    if (!g || !this.showFocus) return;
    showTip(g, this.tip(this.focus));
  }

  // ---------- Drawing ----------

  /** The parts that never change: the frame, the chart's backdrop and the chrome around it. */
  private build0(): void {
    const { width, height } = uiSize();
    const wedge = (reg: number) => {
      const a0 = ((MIDS[reg] - 45) * Math.PI) / 180;
      const a1 = ((MIDS[reg] + 45) * Math.PI) / 180;
      const p = (r: number, a: number) => `${fmt(r * Math.sin(a))} ${fmt(-r * Math.cos(a))}`;
      const R = OUTER + 44;
      return `<path d="M ${p(100, a0)} L ${p(R, a0)} A ${R} ${R} 0 0 1 ${p(R, a1)} L ${p(100, a1)} A 100 100 0 0 0 ${p(100, a0)} Z" fill="${treeColor(reg)}" opacity="0.09"/>`;
    };
    const rose = Array.from({ length: 8 }, (_, i) => {
      const a = (i * 45 * Math.PI) / 180;
      const r = i % 2 ? 120 : 170;
      const q = (rr: number, aa: number) => `${fmt(rr * Math.sin(aa))} ${fmt(-rr * Math.cos(aa))}`;
      return `<path d="M 0 0 L ${q(14, a - 0.5)} L ${q(r, a)} L ${q(14, a + 0.5)} Z"/>`;
    }).join('');
    const labels = MIDS.map((m, reg) => {
      const a = (m * Math.PI) / 180;
      const r = OUTER + 120;
      return `<text class="lbl" x="${fmt(r * Math.sin(a))}" y="${fmt(-r * Math.cos(a) + 12)}" style="--c:${treeColor(reg)}">${esc((TREES[reg]?.name ?? '').toUpperCase())}</text>`;
    }).join('');
    const gems = MIDS.map((m, reg) => {
      const a = (m * Math.PI) / 180;
      return `<circle cx="${fmt(72 * Math.sin(a))}" cy="${fmt(-72 * Math.cos(a))}" r="8" fill="${treeColor(reg)}" stroke="#2b1a0e" stroke-width="3"/>`;
    }).join('');
    const pad = this.ctx.device() === 'gamepad';
    this.el.innerHTML = `<svg class="st-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs><clipPath id="st-pc"><circle r="58"/></clipPath></defs>
        <g class="st-world">
          ${MIDS.map((_, reg) => wedge(reg)).join('')}
          ${ORBITS.map((r) => `<circle class="bg-orbit" r="${r}"/>`).join('')}
          <g class="rose">${rose}</g>${labels}
          <g class="st-edges"></g><g class="st-nodes"></g>
          <g class="ctr"><circle r="74" class="c-o"/>${gems}<circle r="62" class="c-r"/><image class="c-face" x="-58" y="-58" width="116" height="116" clip-path="url(#st-pc)" preserveAspectRatio="xMidYMid slice"/><circle r="58" class="c-i"/></g>
        </g>
      </svg>
      <div class="st-frame"></div>
      <div class="st-top">
        <div class="st-title">Skill Tree</div>
        <div class="st-pts"></div>
        <div class="st-sp"></div>
        <input class="st-search" type="search" placeholder="Search the Tree…" spellcheck="false">
        <div class="st-zoom"><button class="st-btn" data-act="out" aria-label="Zoom Out">−</button><button class="st-btn" data-act="fit" aria-label="Whole Tree">◎</button><button class="st-btn" data-act="in" aria-label="Zoom In">+</button></div>
        <button class="st-btn wide" data-act="book">Skill Book · ${pad ? 'LB' : 'T'}</button>
        <button class="st-btn" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="st-legend"><span><i class="lg s"></i>Passive</span><span><i class="lg nt"></i>Notable</span><span><i class="lg ks"></i>Keystone</span><span><i class="lg skn"></i>Skill</span></div>
      <div class="st-bottom"></div>
      <div class="st-note"></div>
      <div class="st-mini" hidden><svg viewBox="0 0 ${MINI} ${MINI}" width="${MINI}" height="${MINI}"><g class="dots"></g><rect fill="none" stroke="#7a1f26" stroke-width="2"/></svg></div>`;
    this.world = this.el.querySelector('g.st-world')!;
    (this.el.querySelector('.st-search') as HTMLInputElement).value = this.query;
    this.shownPortrait = null;
  }

  render(): void {
    if (!this.world) this.build0();
    this.renderNodes();
    this.renderChrome();
    this.place();
    this.refresh();
  }

  /** Keeps the face in the middle current (portraits arrive a frame or two after they're asked for). */
  refresh(): void {
    const url = this.ctx.portrait();
    if (!url || url === this.shownPortrait) return;
    this.shownPortrait = url;
    this.el.querySelector('image.c-face')?.setAttribute('href', url);
  }

  private matches(i: number): boolean {
    if (!this.query) return false;
    const n = NODES[i];
    return `${n.name} ${nodeLines(n).join(' ')} ${KIND_NAMES[n.kind]}`.toLowerCase().includes(this.query);
  }

  private renderNodes(): void {
    const learned = this.learned();
    const plan = new Set(this.plan);
    const on = (i: number) => hasSkill(learned, i);
    const lit = (i: number) => on(i) || plan.has(i);
    const edges = { plain: [] as string[], planned: [] as string[], learnedO: [] as string[], learned: [] as string[] };
    for (const l of LINKS) {
      const d = edgePath(l.a, l.b, l.arc);
      if (on(l.a) && on(l.b)) {
        edges.learnedO.push(`<path class="e al-o" d="${d}"/>`);
        edges.learned.push(`<path class="e al" d="${d}"/>`);
      } else if (lit(l.a) && lit(l.b)) edges.planned.push(`<path class="e pd" d="${d}"/>`);
      else edges.plain.push(`<path class="e" d="${d}"/>`);
    }
    this.world.querySelector('.st-edges')!.innerHTML = edges.plain.join('') + edges.planned.join('') + edges.learnedO.join('') + edges.learned.join('');
    const searching = !!this.query;
    const nodes = NODES.map((n, i) => {
      const p = POS[i];
      const state = `${on(i) ? ' al' : ''}${plan.has(i) ? ' pd' : ''}${!on(i) && reachable(learned, i) ? ' op' : ''}${this.showFocus && i === this.focus ? ' fc' : ''}${searching ? (this.matches(i) ? ' sr' : ' dim') : ''}`;
      const tr = `transform="translate(${fmt(p.x)} ${fmt(p.y)})"`;
      const attrs = `data-n="${i}" data-tip="node:${i}" ${tr} style="--c:${treeColor(n.tree)}"`;
      const img = (size: number) => {
        const url = n.icon ? iconUrl(n.icon) : null;
        return url ? `<image href="${url}" x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}"/>` : '';
      };
      if (n.kind === 'small') return `<g class="n s${state}" ${attrs}><circle class="hit" r="13"/><circle class="dot" r="7"/></g>`;
      if (n.kind === 'notable') return `<g class="n nt${state}" ${attrs}><circle class="ring" r="14"/><circle class="core" r="10.5"/>${img(16)}</g>`;
      if (n.kind === 'keystone')
        return `<g class="n ks${state}" ${attrs}><rect class="dia" x="-15" y="-15" width="30" height="30" transform="rotate(45)"/><circle class="ring" r="16.5"/><circle class="core" r="12.5"/>${img(20)}</g>`;
      return `<g class="n skn${state}" ${attrs}><rect class="tile" x="-15" y="-15" width="30" height="30" rx="6"/>${img(22)}</g>`;
    });
    this.world.querySelector('.st-nodes')!.innerHTML = nodes.join('');
    // The minimap: everything as dots, what you've learned in gold.
    const k = MINI / (2 * (OUTER + 40));
    const dots = this.el.querySelector('.st-mini .dots');
    if (dots)
      dots.innerHTML = NODES.map(
        (n, i) =>
          `<circle cx="${fmt(MINI / 2 + POS[i].x * k)}" cy="${fmt(MINI / 2 + POS[i].y * k)}" r="${n.kind === 'small' ? 1.3 : 2.2}" fill="${on(i) ? '#e0a83a' : plan.has(i) ? '#7a1f26' : '#9a7a52'}"/>`,
      ).join('');
  }

  private renderChrome(): void {
    const learned = skillCount(this.learned());
    const left = this.pointsLeft;
    const pts = this.el.querySelector('.st-pts');
    if (pts)
      pts.innerHTML = `<span class="st-chip"><b>${Math.max(0, left)}</b> point${left === 1 ? '' : 's'} to spend</span><span class="st-chip st-note-chip">${esc(this.ctx.budgetNote())}</span><span class="st-chip">${learned} learned · ${NODES.length} in all</span>`;
    const bottom = this.el.querySelector('.st-bottom') as HTMLElement | null;
    if (bottom) {
      const n = this.plan.length;
      const pad = this.ctx.device() === 'gamepad';
      bottom.hidden = !n;
      bottom.innerHTML = n
        ? `<span class="st-pending${n > left ? ' over' : ''}">Planned: ${n} Point${n === 1 ? '' : 's'}${n > left ? ` · You Have ${Math.max(0, left)}` : ''}</span>
           <button class="lui-btn gold" data-act="learn"${n > left ? ' disabled' : ''}>Learn${pad ? ' · Y' : ''}</button><button class="lui-btn" data-act="undo">Undo${pad ? ' · B' : ''}</button>`
        : '';
    }
    const note = this.el.querySelector('.st-note') as HTMLElement | null;
    if (note) {
      note.textContent = this.note;
      note.hidden = !this.note;
    }
  }

  /** The tooltip for a node. */
  tip(i: number): string {
    const n = NODES[i];
    if (!n) return '';
    const learned = this.learned();
    const lines = nodeLines(n)
      .map((l) => `<p class="${n.kind === 'skill' ? '' : 'g'}">${esc(l)}</p>`)
      .join('');
    const where = n.tree >= 0 ? treeName(n.tree) : 'Where Two Disciplines Meet';
    let foot: string;
    if (hasSkill(learned, i)) {
      const more = alsoDropped(this.build, NODE_INFO[i]);
      foot = `<div class="row"><span class="muted">Learned</span><b>right-click to give back${more ? ` (+${more})` : ''}</b></div>`;
    } else if (this.plan.includes(i)) {
      foot = `<div class="row"><span class="muted">Planned</span><b>click to take it out</b></div>`;
    } else {
      const cost = pathTo(this.withPlan(), i).length + this.plan.length;
      const left = this.pointsLeft;
      foot = `<div class="row"><span class="muted">${this.plan.length ? 'With Your Plan' : 'From What You Know'}</span><b>${cost} Point${cost === 1 ? '' : 's'}</b></div>
        <div class="row"><span class="muted">${cost > left ? `You have ${Math.max(0, left)}: more come from quests and milestones` : 'Click to plan it · Learn to keep it'}</span></div>`;
    }
    return `<h5>${esc(n.name)}</h5><div class="ty">${KIND_NAMES[n.kind]} · ${esc(where)}</div>${lines}<hr>${foot}`;
  }

  hide(): void {
    hideTip();
  }
}

const MINI = 150;

function edgePath(a: number, b: number, arc: boolean): string {
  const A = POS[a];
  const B = POS[b];
  if (!arc || NODES[a].o !== NODES[b].o) return `M ${fmt(A.x)} ${fmt(A.y)} L ${fmt(B.x)} ${fmt(B.y)}`;
  const r = ORBITS[NODES[a].o];
  // Along the orbit the short way round: clockwise from whichever end it runs clockwise from.
  const d = (NODES[b].a - NODES[a].a + 360) % 360;
  const [p, q] = d <= 180 ? [A, B] : [B, A];
  return `M ${fmt(p.x)} ${fmt(p.y)} A ${r} ${r} 0 0 1 ${fmt(q.x)} ${fmt(q.y)}`;
}

/** Which learned nodes a root reaches through the set: what stays when something leaves a plan. */
function connected(s: SkillSet): boolean[] {
  const seen = NODES.map(() => false);
  const queue = ROOTS.filter((r) => hasSkill(s, r));
  for (const r of queue) seen[r] = true;
  for (let q = 0; q < queue.length; q++) {
    for (const n of ADJACENT[queue[q]]) {
      if (seen[n] || !hasSkill(s, n)) continue;
      seen[n] = true;
      queue.push(n);
    }
  }
  return seen;
}

/** The node a D-pad press goes to: the nearest one roughly that way, linked ones first. */
function nextNode(from: number, dx: number, dy: number): number {
  if (from < 0) return ROOTS[0] ?? 0;
  const p = POS[from];
  let best = -1;
  let bestScore = Infinity;
  NODES.forEach((_, i) => {
    if (i === from) return;
    const vx = POS[i].x - p.x;
    const vy = POS[i].y - p.y;
    const dist = Math.hypot(vx, vy);
    const along = (vx * dx + vy * dy) / dist;
    if (along < 0.5) return; // within 60° of the press
    const score = dist * (2 - along) * (ADJACENT[from].includes(i) ? 0.6 : 1);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best >= 0 ? best : from;
}
