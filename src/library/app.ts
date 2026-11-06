import * as THREE from 'three';
import { Stage, VIEWS, type View } from './stage';
import { GHOST, SIDE_COLOURS, Skeleton, Trails, defaultMarks } from './overlay';
import { Editor } from './editor';
import { Ghosts } from './ghosts';
import { Sheet, type SheetOptions } from './sheet';
import { PHASE_COLOURS, Timeline, type Marker } from './timeline';
import { newId, noteKey, store, type Note, type NoteKind, type PoseFix } from './store';
import { buildPrompt, linkTo } from './prompt';
import { matches, measure, type Measure } from './measure';
import { compact, eulerDeg, modelPositions, readJoint } from './pose';
import { ICON, fmtTime, h, icon, modal, setToastHost, toast } from './dom';
import { GROUP_ORDER, SUBJECTS, subjectById } from './subjects';
import { speciesEditing } from './subjects/species';
import { thumbnails } from './thumbs';
import type { AnimDef, Bone, Gallery, Options, Posable, Subject, Take } from './types';

// The content library: pick something, then one of its animations; play it, scrub it, step it a
// frame at a time; leave notes on the whole of it, on a stretch of frames or on one frame, and on a
// frame put the bones where they should have been. "Create Prompt" turns the open notes into one
// prompt for Claude (prompt.ts); the corrected poses stay on screen as ghosts on their frames, so
// once Claude has changed the code (the page reloads by itself) you can see how close it came. A
// gallery (every model, the buildings, a crowd) is drawn in a scene of its own in the same place,
// with its options on the left and its numbers on the right.

type Tab = 'notes' | 'pose' | 'about' | 'numbers';
type Scope = 'anim' | 'subject' | 'all';

interface Composer {
  kind: NoteKind;
  frame?: number;
  range?: [number, number];
  fix?: PoseFix;
  picture?: HTMLCanvasElement;
  text: string;
}

const PREFS = 'ruina.animLibrary.prefs';
const CAMERA = 'ruina.animLibrary.camera';
const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2];

interface Prefs {
  skeleton: boolean;
  /** Takes drawn on the studio's backdrop drawn outdoors instead, on grass under the sky. */
  outdoors: boolean;
  swoosh: boolean;
  onion: boolean;
  trails: boolean;
  ghosts: boolean;
  loop: boolean;
  view: View;
  speed: number;
  onionCount: number;
}

function loadPrefs(): Prefs {
  const base: Prefs = {
    skeleton: true,
    outdoors: false,
    swoosh: true,
    onion: false,
    trails: false,
    ghosts: true,
    loop: true,
    view: 'three',
    speed: 1,
    onionCount: 2,
  };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>) };
  } catch {
    return base;
  }
}

export class App {
  readonly stage: Stage;
  readonly skeleton = new Skeleton();
  readonly trails = new Trails();
  readonly editor: Editor;
  readonly ghosts: Ghosts;
  /** The contact sheet, when one is laid out instead of the take. */
  readonly sheet: Sheet;
  readonly timeline = new Timeline();
  prefs = loadPrefs();

  subject: Subject | null = null;
  options: Options = {};
  anim: AnimDef | null = null;
  take: Take | null = null;
  /** The gallery entry in the viewport instead of a take, if one is open. */
  gallery: Gallery | null = null;
  frame = 0;
  playing = true;
  range: [number, number] | null = null;
  private acc = 0;
  private dirty = true;
  private lastT = performance.now();
  private takes = new Map<string, Take>();
  private measureRig: Posable | null = null;
  private measures = new Map<string, Measure | null>();
  private composer: Composer | null = null;
  private editingNote: string | null = null;
  private confirmDelete: string | null = null;
  private tab: Tab = 'notes';
  private libView: 'subjects' | 'anims' = 'subjects';
  private search = '';
  private opening = 0;
  private thumbs = new Map<string, string>();

  // DOM
  private el = {
    crumbs: h('nav', { class: 'crumbs' }),
    count: h('button', { class: 'pill-count', title: 'Every note, on every animation' }),
    libBody: h('div', { class: 'lib-body' }),
    viewport: h('div', { class: 'viewport' }),
    views: h('div', { class: 'views glass' }),
    toggles: h('div', { class: 'toggles glass' }),
    hud: h('div', { class: 'hud glass' }),
    legend: h('div', { class: 'legend glass' }),
    banner: h('div', { class: 'banner' }),
    loading: h('div', { class: 'loading' }),
    toasts: h('div', { class: 'toast-host' }),
    tbar: h('div', { class: 'tbar' }),
    tabs: h('div', { class: 'tabs' }),
    pane: h('div', { class: 'pane' }),
    frameInput: h('input', { type: 'text', spellcheck: 'false', title: 'Go to frame' }),
  };

  constructor(private readonly host: HTMLElement) {
    const top = h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo', html: ICON.play }), 'Content Library', h('small', {}, 'Ruina')),
      this.el.crumbs,
      h('div', { class: 'spacer' }),
      h(
        'div',
        { class: 'top-actions' },
        this.el.count,
        h(
          'button',
          { class: 'btn primary', title: 'Turn the open notes into a prompt for Claude (Ctrl+Enter)', onclick: () => void this.openPrompt() },
          icon('spark'),
          'Create Prompt',
        ),
        h('button', { class: 'icon-btn', title: 'Keyboard shortcuts (?)', onclick: () => this.openHelp() }, icon('help')),
      ),
    );
    const search = h('input', { type: 'search', placeholder: 'Search the library', spellcheck: 'false' });
    search.addEventListener('input', () => {
      this.search = search.value.trim().toLowerCase();
      this.renderLibrary();
    });
    const lib = h('aside', { class: 'library' }, h('div', { class: 'search' }, search), this.el.libBody);
    this.el.viewport.append(
      h('div', { class: 'vp-bar vp-tl' }, this.el.views),
      h('div', { class: 'vp-bar vp-tr' }, this.el.toggles),
      h('div', { class: 'vp-bar vp-bl' }, this.el.legend, this.el.hud),
      this.el.banner,
      this.el.loading,
      this.el.toasts,
    );
    const transport = h('div', { class: 'transport' }, this.el.tbar, this.timeline.el);
    const center = h('main', { class: 'center' }, this.el.viewport, transport);
    const side = h('aside', { class: 'side' }, this.el.tabs, this.el.pane);
    host.append(top, lib, center, side);
    setToastHost(this.el.toasts);
    this.el.count.onclick = () => this.openAllNotes();

    this.stage = new Stage(this.el.viewport);
    this.stage.overlay.add(this.skeleton.group, this.trails.group);
    this.editor = new Editor(this.stage);
    this.editor.onChange = () => {
      this.skeleton.selected = this.editor.selected?.name ?? null;
      this.skeleton.update();
      this.editor.sync();
      if (this.editor.isDragging) {
        this.updatePoseNumbers();
        return;
      }
      this.renderBanner();
      if (this.tab === 'pose') this.renderPose();
    };
    this.editor.gizmo.addEventListener('dragging-changed', () => {
      if (this.editor.isDragging) return;
      this.renderBanner();
      if (this.tab === 'pose') this.renderPose();
    });
    this.ghosts = new Ghosts(this.stage);
    this.sheet = new Sheet(this.stage);
    this.stage.controls.addEventListener('change', () => this.saveCamera());

    this.timeline.onSeek = (f) => this.seek(f);
    this.timeline.onScrubStart = () => this.pause();
    this.timeline.onRange = (r) => {
      this.range = r;
      this.renderTransport();
    };
    this.timeline.onMarker = (id) => this.goToNote(id);

    this.bindPointer();
    this.bindKeys();
    store.on(() => this.notesChanged());
    // A link pasted into this tab opens what it names.
    window.addEventListener('hashchange', () => void this.route());
    this.renderAll();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---------- opening a subject and an animation ----------

  defaults(subject: Subject, given: Options = {}): Options {
    const o: Options = {};
    for (const opt of subject.options) o[opt.id] = given[opt.id] ?? opt.value;
    return o;
  }

  private takeKey(sid: string, aid: string, o: Options): string {
    return noteKey(sid, aid, this.keyed(sid, aid, o));
  }

  /** The options that make a difference to an animation (what its notes are kept under). */
  keyed(sid: string, aid: string, o: Options): Options {
    const s = subjectById(sid);
    return s?.optionsFor ? s.optionsFor(aid, o) : o;
  }

  /** A take of an animation, from the cache or made now (the subject must be ready). */
  takeOf(sid: string, aid: string, o: Options): Take | null {
    const subject = subjectById(sid);
    if (!subject?.take) return null;
    const key = this.takeKey(sid, aid, o);
    let t = this.takes.get(key);
    if (!t) {
      if (!subject.anims(o).some((a) => a.id === aid) && !subject.find?.(aid, o)) return null;
      t = subject.take(aid, o);
      this.takes.set(key, t);
      // Keep the last few: switching back is instant, memory stays bounded.
      if (this.takes.size > 6) {
        for (const [k, old] of this.takes) {
          if (old === this.take || k === key) continue;
          old.dispose();
          this.takes.delete(k);
          break;
        }
      }
    }
    return t;
  }

  async open(
    sid: string,
    aid: string | null,
    given: Options = {},
    frame = 0,
    opts: { range?: [number, number] | null; keepCamera?: boolean } = {},
  ): Promise<void> {
    const subject = subjectById(sid);
    if (!subject) return;
    if (this.editor.active) {
      if (this.editor.dirty) {
        toast('Save or discard the correction you are making first', 'warn');
        return;
      }
      this.leaveEdit();
    }
    this.endSheet();
    const options = this.defaults(subject, given);
    const anims = subject.anims(options);
    const anim = anims.find((a) => a.id === aid) ?? (aid ? subject.find?.(aid, options) : null) ?? anims[0];
    if (!anim) return;
    const ticket = ++this.opening;
    this.el.loading.textContent = subject.ready ? `Loading ${subject.name}…` : '';
    try {
      await subject.ready?.(options, anim.id);
    } catch (e) {
      console.warn(e);
    }
    if (ticket !== this.opening) return;
    this.el.loading.textContent = '';
    const sameSubject = this.subject?.id === subject.id;
    this.subject = subject;
    this.options = options;
    this.anim = anim;
    this.libView = 'anims';
    if (subject.gallery) {
      this.showGallery(subject.gallery(this.el.viewport, anim.id, options));
      return;
    }
    this.closeGallery();
    const take = this.takeOf(subject.id, anim.id, options);
    if (!take) {
      toast(`${subject.name} could not make ${anim.label}`, 'warn');
      return;
    }
    if (this.take !== take) {
      this.stage.bodies.clear();
      this.stage.bodies.add(take.root);
      this.take = take;
      this.ghosts.reset(take);
      this.measureRig?.dispose();
      this.measureRig = null;
      this.measures.clear();
      this.trails.clear();
      this.skeleton.setBody(take, take.framing.height);
    }
    this.applyBackdrop();
    const saved = this.savedCamera();
    if (opts.keepCamera && sameSubject) {
      /* keep the camera where it is */
    } else if (saved) {
      this.stage.frame(take.framing, this.prefs.view);
      this.stage.setCamera(saved);
    } else this.stage.frame(take.framing, this.prefs.view);
    this.timeline.set(take.frames, take.fps, take.phases);
    this.timeline.baked = take.baked;
    this.frame = Math.max(0, Math.min(take.frames - 1, frame));
    this.range = opts.range ?? null;
    this.timeline.range = this.range;
    this.acc = 0;
    this.composer = null;
    this.editingNote = null;
    this.dirty = true;
    this.updateMarkers();
    this.renderAll();
    this.writeHash();
  }

  /** Puts a gallery entry in the viewport in place of the take: its own picture, options and numbers. */
  private showGallery(g: Gallery): void {
    this.closeGallery();
    this.stage.bodies.clear();
    this.take = null;
    this.ghosts.reset(null);
    this.measureRig?.dispose();
    this.measureRig = null;
    this.measures.clear();
    this.trails.clear();
    this.skeleton.setBody(null);
    this.gallery = g;
    this.el.viewport.prepend(g.el);
    this.host.classList.add('gallery-open');
    if (this.tab !== 'numbers' || !g.numbers) this.tab = 'about';
    this.composer = null;
    this.editingNote = null;
    this.range = null;
    this.frame = 0;
    this.renderAll();
    this.writeHash();
  }

  private closeGallery(): void {
    if (!this.gallery) return;
    this.gallery.dispose();
    this.gallery.el.remove();
    this.gallery = null;
    this.host.classList.remove('gallery-open');
    if (this.tab === 'numbers') this.tab = 'notes';
  }

  // ---------- playing ----------

  private galleryFrames = 0;
  /** Frames drawn so far: what tests wait on, never a fixed time. */
  frameCount = 0;

  private loop(now: number): void {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.frameCount++;
    if (this.gallery) {
      this.gallery.frame(dt);
      // Its numbers can change as it goes (a cost measured, a model loaded): kept current twice a second.
      if (this.tab === 'numbers' && ++this.galleryFrames % 30 === 0) this.renderNumbers();
      return;
    }
    const take = this.take;
    if (take) {
      // Bake ahead in the background, a few milliseconds a frame (never while a pose is being corrected).
      if (take.baked < take.frames && !this.editor.active) {
        const t0 = performance.now();
        while (performance.now() - t0 < 6 && !take.bake(4)) {
          /* keep going */
        }
        this.timeline.baked = take.baked;
        this.dirty = true;
        if (take.baked >= take.frames) this.baked();
      }
      if (this.prefs.trails && !this.trails.built && take.baked >= take.frames && !this.editor.active) this.buildTrails();
      if (this.playing && !this.editor.active) {
        this.acc += dt * this.prefs.speed * take.fps;
        const steps = Math.floor(this.acc);
        if (steps > 0) {
          this.acc -= steps;
          this.advance(steps);
        }
      }
      if (this.dirty) this.present();
    }
    this.stage.render();
  }

  private advance(n: number): void {
    const take = this.take!;
    const [lo, hi] = this.range ?? [0, take.frames - 1];
    let f = this.frame + n;
    if (f < lo) f = lo;
    if (f > hi) {
      if (this.prefs.loop) f = lo + ((f - lo) % (hi - lo + 1));
      else {
        f = hi;
        this.playing = false;
        this.renderTransport();
      }
    }
    if (f !== this.frame) {
      this.frame = f;
      this.dirty = true;
    }
  }

  /** Every frame worked out: what needs them all (paths, how close corrections are) can be done. */
  private baked(): void {
    this.measures.clear();
    if (this.tab === 'notes') this.renderNotes();
  }

  /** Shows the current frame: the body, the floor, ghosts, skeleton, timeline, readout. */
  private present(): void {
    const take = this.take!;
    take.setDecor?.(this.prefs.swoosh && !this.editor.active);
    if (!this.editor.active) take.show(this.frame);
    const ground = take.ground(this.frame);
    // A contact sheet's bodies each stand where they are laid out: the floor stays put under them.
    this.stage.setGround(this.sheet.active ? { ...ground, x: 0, z: 0 } : ground);
    this.updateGhosts();
    take.root.updateMatrixWorld(true);
    this.skeleton.visible = this.prefs.skeleton || this.editor.active;
    this.skeleton.update();
    this.trails.group.visible = this.prefs.trails;
    this.trails.setFrame(this.frame);
    this.timeline.frame = this.frame;
    this.timeline.follow();
    this.timeline.draw();
    this.renderHud();
    this.dirty = false;
  }

  private updateGhosts(): void {
    const take = this.take!;
    this.ghosts.begin();
    if (this.prefs.onion && !this.editor.active) {
      const step = Math.max(1, Math.round(take.fps / 15));
      for (let k = this.prefs.onionCount; k >= 1; k--) {
        for (const [dir, look] of [
          [-1, GHOST.before],
          [1, GHOST.after],
        ] as const) {
          let f = this.frame + dir * k * step;
          if (take.loop) f = ((f % take.frames) + take.frames) % take.frames;
          if (f < 0 || f >= take.frames || f >= take.baked) continue;
          const g = this.ghosts.next(look.color, look.opacity * (1 - (k - 1) / (this.prefs.onionCount + 1)));
          g?.apply(take.snapshot(f));
        }
      }
    }
    if (this.prefs.ghosts && !this.editor.active) {
      for (const n of this.notesHere()) {
        if (!n.fix || n.frame !== this.frame) continue;
        const g = this.ghosts.next(
          n.status === 'done' ? GHOST.original.color : GHOST.target.color,
          n.status === 'done' ? GHOST.original.opacity : GHOST.target.opacity,
        );
        g?.apply(n.fix.after);
      }
    }
    if (this.editor.active) {
      const g = this.ghosts.next(GHOST.original.color, 0.2);
      g?.apply(take.snapshot(this.frame));
    }
    this.ghosts.end();
  }

  private buildTrails(): void {
    const take = this.take;
    if (!take || take.baked < take.frames || this.editor.active) return;
    const marks = defaultMarks(take.bones);
    // What a hand holds traces its own path (a blade's tip), if it is out.
    for (const p of take.points ?? []) {
      const b = take.bones.find((x) => x.name === p.bone);
      if (b?.object.visible) marks.push({ name: p.name, bone: p.bone, at: p.at, color: 0xffffff });
    }
    this.trails.build(take, marks);
    take.show(this.frame);
    this.dirty = true;
  }

  /** Draws the frame again (after something outside the loop worked frames out). */
  redraw(): void {
    this.dirty = true;
  }

  /**
   * A contact sheet of the animation: eight frames side by side (or those asked for), spread over the
   * picked stretch or the whole of it, drawn in place of the take until anything else is asked.
   */
  showSheet(o: SheetOptions = {}): number[] {
    const take = this.take;
    if (!take || !this.subject || !this.anim || this.editor.active) return [];
    this.pause();
    const range = this.range ? { from: this.range[0], to: this.range[1] + 1 } : {};
    const frames = this.sheet.show(this.subject, this.anim.id, this.options, take.frames, take.framing, take.framing.distance > 5, this.stage.view, {
      ...range,
      ...o,
    });
    take.root.visible = false;
    this.stage.overlay.visible = false;
    this.stage.ghosts.visible = false;
    this.dirty = true;
    this.renderViewBar();
    return frames;
  }

  endSheet(): void {
    if (!this.sheet.active) return;
    this.sheet.clear();
    if (this.take) {
      this.take.root.visible = true;
      this.stage.frame(this.take.framing, this.stage.view);
    }
    this.stage.overlay.visible = true;
    this.stage.ghosts.visible = true;
    this.dirty = true;
    this.renderViewBar();
  }

  play(): void {
    if (this.editor.active) return;
    this.endSheet();
    if (this.take && !this.prefs.loop) {
      const hi = this.range ? this.range[1] : this.take.frames - 1;
      if (this.frame >= hi) this.frame = this.range ? this.range[0] : 0;
    }
    this.playing = true;
    this.acc = 0;
    this.renderTransport();
  }

  pause(): void {
    this.playing = false;
    this.renderTransport();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(f: number): void {
    const take = this.take;
    if (!take) return;
    this.endSheet();
    if (this.editor.active) {
      if (this.editor.dirty) {
        toast('Save or discard the correction first (Esc discards)', 'warn');
        return;
      }
      this.leaveEdit();
    }
    const nf = Math.max(0, Math.min(take.frames - 1, Math.round(f)));
    if (nf !== this.frame) {
      this.frame = nf;
      this.dirty = true;
      this.writeHashSoon();
    }
  }

  step(n: number): void {
    this.pause();
    const take = this.take;
    if (!take) return;
    let f = this.frame + n;
    if (take.loop || this.prefs.loop) f = ((f % take.frames) + take.frames) % take.frames;
    this.seek(f);
  }

  setRange(r: [number, number] | null): void {
    this.range = r ? [Math.min(r[0], r[1]), Math.max(r[0], r[1])] : null;
    this.timeline.range = this.range;
    this.timeline.draw();
    this.renderTransport();
    this.writeHashSoon();
  }

  // ---------- correcting a pose ----------

  enterEdit(bone?: Bone): void {
    const take = this.take;
    if (!take) return;
    this.pause();
    // Every frame worked out first: nothing may step the body while it's being posed.
    while (!take.bake(120)) {
      /* bake */
    }
    this.timeline.baked = take.baked;
    take.show(this.frame);
    take.root.updateMatrixWorld(true);
    speciesEditing(take, true);
    this.editor.begin(take);
    if (bone) this.editor.select(bone);
    this.tab = 'pose';
    this.dirty = true;
    this.renderAll();
  }

  leaveEdit(): void {
    if (!this.editor.active) return;
    this.editor.end();
    if (this.take) speciesEditing(this.take, false);
    this.take?.show(this.frame);
    if (this.composer?.fix) this.composer = null;
    this.dirty = true;
    this.renderAll();
  }

  /** Keeps the corrected pose: a picture of it, then the note's words. */
  async saveCorrection(): Promise<void> {
    const take = this.take;
    if (!take || !this.editor.active) return;
    if (!this.editor.dirty) {
      toast('Move a bone first: drag a joint, or pick one and turn it', 'warn');
      return;
    }
    const after = compact(take.capture());
    const before = compact(take.snapshot(this.frame));
    const shot = this.picture(before, after);
    const fix: PoseFix = {
      before,
      after,
      touched: [...this.editor.touched],
      model: { before: round3(shot.modelBefore), after: round3(shot.modelAfter) },
      camera: this.stage.cameraState(),
    };
    this.composer = { kind: 'frame', frame: this.frame, fix, picture: shot.canvas, text: this.composer?.text ?? '' };
    this.tab = 'notes';
    this.renderAll();
  }

  /**
   * Draws the frame as it is and as corrected, from the user's view and from the side: one picture
   * for the note and the prompt. Measures where the joints are in each on the way.
   */
  private picture(
    before: ReturnType<Take['snapshot']>,
    after: ReturnType<Take['snapshot']>,
  ): { canvas: HTMLCanvasElement; modelBefore: Record<string, number[]>; modelAfter: Record<string, number[]> } {
    const take = this.take!;
    const helper = this.editor.gizmo.getHelper();
    const was = { overlay: this.stage.overlay.visible, ghosts: this.stage.ghosts.visible, helper: helper.visible };
    this.stage.overlay.visible = false;
    helper.visible = false;
    take.setDecor?.(false);
    const second: View = this.stage.view === 'side' || this.stage.view === 'left' ? 'front' : 'side';
    // As it is.
    this.stage.ghosts.visible = false;
    take.apply(before);
    take.root.updateMatrixWorld(true);
    const modelBefore = modelPositions(take);
    const a1 = this.stage.snapshot();
    const a2 = this.stage.snapshotFrom(second);
    // As corrected, the old pose faint behind it.
    this.ghosts.begin();
    this.ghosts.next(GHOST.original.color, 0.22)?.apply(before);
    this.ghosts.end();
    this.stage.ghosts.visible = true;
    take.apply(after);
    take.root.updateMatrixWorld(true);
    const modelAfter = modelPositions(take);
    const b1 = this.stage.snapshot();
    const b2 = this.stage.snapshotFrom(second);
    this.stage.overlay.visible = was.overlay;
    this.stage.ghosts.visible = was.ghosts;
    helper.visible = was.helper;
    this.dirty = true;
    return {
      canvas: compose(
        [a1, b1, a2, b2],
        [`Frame ${this.frame}: as it is`, 'As corrected', 'From the side: as it is', 'As corrected'],
        second === 'front' ? 'Front' : 'Side',
      ),
      modelBefore,
      modelAfter,
    };
  }

  // ---------- notes ----------

  notesHere(): Note[] {
    if (!this.subject || !this.anim) return [];
    return store.forAnim(this.subject.id, this.anim.id, this.keyed(this.subject.id, this.anim.id, this.options));
  }

  private notesChanged(): void {
    this.updateMarkers();
    this.renderCount();
    if (this.tab === 'notes') this.renderNotes();
    this.renderLibrary();
    this.dirty = true;
  }

  private updateMarkers(): void {
    this.timeline.markers = this.notesHere().map(
      (n): Marker => ({
        id: n.id,
        kind: n.kind,
        from: n.kind === 'range' ? n.range![0] : (n.frame ?? 0),
        to: n.kind === 'range' ? n.range![1] : (n.frame ?? 0),
        done: n.status === 'done',
        fix: !!n.fix,
        text: n.text,
      }),
    );
    this.timeline.draw();
  }

  compose(kind: NoteKind): void {
    if (!this.take) return;
    if (this.editor.active && kind === 'frame') {
      void this.saveCorrection();
      return;
    }
    if (kind === 'range' && !this.range) {
      toast('Pick a stretch first: shift-drag on the timeline, or [ and ] at its ends', 'warn');
      return;
    }
    this.pause();
    this.composer = { kind, frame: kind === 'frame' ? this.frame : undefined, range: kind === 'range' ? this.range! : undefined, text: '' };
    this.tab = 'notes';
    this.renderAll();
  }

  private async submitComposer(): Promise<void> {
    const c = this.composer;
    const take = this.take;
    if (!c || !take || !this.subject || !this.anim) return;
    if (!c.text.trim() && !c.fix) {
      toast('Say what is wrong, in a few words', 'warn');
      return;
    }
    const id = newId();
    const at = c.kind === 'frame' ? c.frame! : c.kind === 'range' ? c.range![0] : null;
    const note: Note = {
      id,
      subject: this.subject.id,
      subjectName: this.subject.name,
      options: this.keyed(this.subject.id, this.anim.id, this.options),
      anim: this.anim.id,
      animLabel: this.anim.label,
      kind: c.kind,
      frame: c.frame,
      range: c.range,
      text: c.text.trim(),
      state: at !== null ? take.info(at) : undefined,
      frames: take.frames,
      fps: take.fps,
      status: 'open',
      created: Date.now(),
      updated: Date.now(),
    };
    if (c.fix) {
      if (c.picture) c.fix.image = await store.putImage(`${id}.png`, c.picture);
      note.fix = c.fix;
    }
    store.add(note);
    this.composer = null;
    if (this.editor.active) this.leaveEdit();
    toast(note.fix ? 'Correction kept: it shows as a green ghost on its frame' : 'Note kept', 'good');
    this.renderAll();
  }

  private goToNote(id: string): void {
    const n = store.notes.find((x) => x.id === id);
    if (!n) return;
    if (
      n.subject !== this.subject?.id ||
      n.anim !== this.anim?.id ||
      noteKey(n.subject, n.anim, n.options) !== noteKey(n.subject, n.anim, this.keyed(n.subject, n.anim, this.options))
    ) {
      void this.open(n.subject, n.anim, { ...this.options, ...n.options }, n.frame ?? n.range?.[0] ?? 0, { range: n.range ?? null });
      return;
    }
    this.pause();
    if (n.kind === 'range') {
      this.setRange(n.range!);
      this.seek(n.range![0]);
    } else if (n.kind === 'frame') this.seek(n.frame!);
    if (n.fix && n.fix.camera) this.stage.setCamera(n.fix.camera);
  }

  /** How close the code's pose comes to a note's correction (null until the take is worked out). */
  private measureNote(n: Note): Measure | null {
    const take = this.take;
    if (!take || !n.fix || n.frame === undefined || take.baked <= n.frame) return null;
    if (this.measures.has(n.id)) return this.measures.get(n.id)!;
    this.measureRig ??= take.ghost();
    const m = measure(take, this.measureRig, n);
    this.measures.set(n.id, m);
    return m;
  }

  // ---------- prompts ----------

  async promptText(scope: Scope): Promise<{ text: string; notes: Note[] }> {
    const open = store.notes.filter((n) => n.status === 'open');
    const notes = open.filter((n) =>
      scope === 'all'
        ? true
        : scope === 'subject'
          ? n.subject === this.subject?.id
          : n.subject === this.subject?.id &&
            n.anim === this.anim?.id &&
            noteKey(n.subject, n.anim, n.options) === noteKey(n.subject, n.anim, this.keyed(n.subject, n.anim, this.options)),
    );
    // Whatever the notes are on has to be ready to describe (a made body loaded).
    for (const sid of new Set(notes.map((n) => n.subject))) {
      const s = subjectById(sid);
      for (const n of notes.filter((x) => x.subject === sid)) if (s?.ready) await s.ready(n.options, n.anim).catch(() => undefined);
    }
    const text = buildPrompt(notes, {
      subject: subjectById,
      take: (sid, aid, o) => {
        const s = subjectById(sid);
        return s ? this.takeOf(sid, aid, this.defaults(s, o)) : null;
      },
      image: (name) => store.image(name),
      reviewFile: store.dir ? `${store.dir}${store.dir.includes('\\') ? '\\' : '/'}review.json` : null,
      origin: location.origin,
    });
    return { text, notes };
  }

  async openPrompt(): Promise<void> {
    if (this.composer?.text.trim()) {
      toast('Keep or cancel the note you are writing first', 'warn');
      return;
    }
    await store.flush();
    let scope: Scope = store.count((n) => n.status === 'open') ? 'all' : 'anim';
    const area = h('textarea', { class: 'prompt-text', readonly: true, spellcheck: 'false' });
    const stats = h('div', { class: 'stats' });
    const seg = h('div', { class: 'seg' });
    const where = h('span', { class: 'grow' });
    let current: { text: string; notes: Note[] } = { text: '', notes: [] };
    const refresh = async () => {
      seg.replaceChildren(
        ...(
          [
            ['anim', 'This Animation'],
            ['subject', `All of ${this.subject?.name ?? 'This Character'}`],
            ['all', 'Everything Open'],
          ] as Array<[Scope, string]>
        ).map(([s, label]) =>
          h(
            'button',
            {
              class: s === scope ? 'on' : '',
              onclick: () => {
                scope = s;
                void refresh();
              },
            },
            label,
          ),
        ),
      );
      current = await this.promptText(scope);
      const n = current.notes;
      area.value = n.length
        ? current.text
        : 'No open notes here yet.\n\nLeave a note on the animation, on a stretch of frames, or correct a frame by moving its bones, then come back.';
      const fixes = n.filter((x) => x.fix).length;
      const anims = new Set(n.map((x) => `${x.subject}/${x.anim}`)).size;
      stats.replaceChildren(
        h('span', {}, h('b', {}, String(n.length)), ' notes'),
        h('span', {}, h('b', {}, String(fixes)), ' pose corrections'),
        h('span', {}, h('b', {}, String(anims)), ' animations'),
        h('span', {}, h('b', {}, `${Math.round(current.text.length / 1000)}k`), ' characters'),
      );
      copy.disabled = !n.length;
    };
    const copy = h('button', { class: 'btn primary', onclick: () => void doCopy() }, icon('copy'), 'Copy Prompt');
    const doCopy = async () => {
      const text = current.text;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        area.removeAttribute('readonly');
        area.select();
        ok = document.execCommand('copy');
        area.setAttribute('readonly', '');
      }
      const path = await store.savePrompt(text);
      const now = Date.now();
      for (const n of current.notes) store.update(n.id, { sent: now });
      where.textContent = path ? `Also saved to ${path}` : '';
      toast(ok ? 'Prompt copied: paste it to Claude' : 'Could not reach the clipboard: select the text and copy it', ok ? 'good' : 'warn', 3200);
    };
    modal({
      title: 'Create Prompt',
      sub: 'Everything Claude needs to fix the animations: what moves them and where, your notes, and your corrected poses in numbers and pictures.',
      body: h('div', {}, h('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:10px' }, seg), area, stats),
      foot: [where, h('button', { class: 'btn', onclick: () => this.openAllNotes() }, icon('list'), 'All Notes'), copy],
    });
    await refresh();
  }

  // ---------- the panels ----------

  renderAll(): void {
    this.renderCrumbs();
    this.renderCount();
    this.renderLibrary();
    this.renderViewBar();
    this.renderTransport();
    this.renderTabs();
    this.renderBanner();
    this.renderHud();
  }

  private renderCrumbs(): void {
    const c = this.el.crumbs;
    c.replaceChildren();
    if (!this.subject || !this.anim) {
      c.append(h('span', {}, 'Pick something'));
      return;
    }
    const optWords = this.subject.options
      .map((o) => (o.choices ? o.choices.find((x) => x.value === this.options[o.id])?.label : this.options[o.id] ? `${o.label} ${this.options[o.id]}` : ''))
      .filter(Boolean)
      .join(' · ');
    const frames = this.take?.frames ?? this.anim.frames;
    const fps = this.take?.fps ?? this.anim.fps;
    c.append(
      ...[
        h('span', { class: 'sep' }, '/'),
        h('span', {}, this.subject.name),
        h('span', { class: 'sep' }, '/'),
        h('b', {}, this.anim.label),
        optWords ? h('span', { class: 'tag' }, optWords) : null,
        h('span', { class: 'tag' }, this.gallery ? (this.anim.tag ?? '') : `${frames} f · ${fmtTime(frames, fps)}`),
      ].filter((x): x is HTMLElement => !!x && !!x.textContent),
    );
  }

  private renderCount(): void {
    const open = store.count((n) => n.status === 'open');
    const fixes = store.count((n) => n.status === 'open' && !!n.fix);
    this.el.count.className = `pill-count${open ? '' : ' none'}`;
    this.el.count.replaceChildren(
      h('span', { class: 'dot' }),
      open ? `${open} open ${open === 1 ? 'note' : 'notes'}${fixes ? `, ${fixes} with poses` : ''}` : 'No open notes',
    );
  }

  private thumb(subject: Subject): HTMLElement {
    const url = this.thumbs.get(subject.id);
    return h('div', { class: 'thumb' }, url ? h('img', { src: url, alt: '' }) : subject.name.slice(0, 1));
  }

  setThumb(id: string, url: string): void {
    this.thumbs.set(id, url);
    this.renderLibrary();
  }

  renderLibrary(): void {
    const body = this.el.libBody;
    const scroll = body.scrollTop;
    body.replaceChildren();
    const q = this.search;
    if (q) {
      // Everything that matches, characters and animations alike.
      let any = false;
      for (const s of SUBJECTS) {
        const o = s.id === this.subject?.id ? this.options : this.defaults(s);
        const hitsSubject = `${s.name} ${s.blurb} ${s.group}`.toLowerCase().includes(q);
        const anims = s.anims(o).filter((a) => hitsSubject || `${a.label} ${a.id} ${a.group}`.toLowerCase().includes(q));
        if (!anims.length) continue;
        any = true;
        body.append(h('div', { class: 'lib-group' }, s.name));
        for (const a of anims.slice(0, 40)) body.append(this.animRow(s, a, o, true));
      }
      if (!any) body.append(h('div', { class: 'empty' }, 'Nothing by that name.'));
      return;
    }
    if (this.libView === 'subjects' || !this.subject) {
      for (const group of GROUP_ORDER) {
        const list = SUBJECTS.filter((s) => s.group === group);
        if (!list.length) continue;
        body.append(h('div', { class: 'lib-group' }, group));
        for (const s of list) {
          const open = store.count((n) => n.subject === s.id && n.status === 'open');
          body.append(
            h(
              'button',
              {
                class: `subject${s.id === this.subject?.id ? ' on' : ''}`,
                onclick: () => void this.open(s.id, null, s.id === this.subject?.id ? this.options : {}),
              },
              this.thumb(s),
              h(
                'div',
                { class: 'meta' },
                h('div', { class: 'name' }, s.name, open ? h('span', { class: 'badge' }, String(open)) : null),
                h('div', { class: 'blurb' }, s.blurb),
              ),
              h('span', { class: 'count', title: 'Animations' }, String(s.anims(this.defaults(s)).length)),
            ),
          );
        }
      }
      return;
    }
    const s = this.subject;
    body.append(
      h('button', { class: 'back', onclick: () => ((this.libView = 'subjects'), this.renderLibrary()) }, icon('back'), 'Everything'),
      h('div', { class: 'subject-head' }, this.thumb(s), h('div', {}, h('h2', {}, s.name), h('p', {}, s.blurb))),
    );
    if (s.options.length) {
      const opts = h('div', { class: 'opts' });
      // An option this animation doesn't use (a film with a weapon of its own) is shown but greyed.
      const used = this.anim && s.optionsFor ? Object.keys(s.optionsFor(this.anim.id, this.options)) : null;
      const set = (id: string, value: string) =>
        void this.open(s.id, this.anim?.id ?? null, { ...this.options, [id]: value }, this.frame, { keepCamera: true });
      for (const o of s.options) {
        const idle = used !== null && !used.includes(o.id);
        let field: HTMLElement;
        if (o.choices)
          field = h(
            'div',
            { class: 'seg' },
            ...o.choices.map((c) => h('button', { class: this.options[o.id] === c.value ? 'on' : '', onclick: () => set(o.id, c.value) }, c.label)),
          );
        else {
          // A value of its own: typed in, kept on Enter (or leaving the box).
          const input = h('input', { type: 'text', class: 'opt-text', spellcheck: 'false', placeholder: o.hint ?? '', value: this.options[o.id] ?? '' });
          const keep = () => input.value.trim() !== (this.options[o.id] ?? '') && set(o.id, input.value.trim());
          input.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') keep();
          };
          input.onchange = keep;
          field = input;
        }
        opts.append(
          h(
            'div',
            { class: `opt${idle ? ' idle' : ''}`, title: idle ? `${this.anim?.label} has its own ${o.label.toLowerCase()}` : '' },
            h(
              'label',
              {},
              o.label,
              idle ? h('span', { class: 'muted', style: 'text-transform:none;letter-spacing:0;font-weight:400' }, ' · this one has its own') : null,
            ),
            field,
          ),
        );
      }
      body.append(opts);
    }
    let group = '';
    for (const a of s.anims(this.options)) {
      if (a.group !== group) {
        group = a.group;
        body.append(h('div', { class: 'lib-group' }, group));
      }
      body.append(this.animRow(s, a, this.options, false));
    }
    body.scrollTop = scroll;
  }

  private animRow(s: Subject, a: AnimDef, o: Options, showOwner: boolean): HTMLElement {
    const notes = store.forAnim(s.id, a.id, this.keyed(s.id, a.id, o)).filter((n) => n.status === 'open');
    const fixes = notes.filter((n) => n.fix).length;
    const on = s.id === this.subject?.id && a.id === this.anim?.id;
    return h(
      'button',
      { class: `anim${on ? ' on' : ''}`, onclick: () => void this.open(s.id, a.id, o, 0, { keepCamera: s.id === this.subject?.id }), title: a.note ?? '' },
      h('span', { class: 'label' }, a.label, showOwner ? h('span', { class: 'owner' }, ` · ${s.name}`) : null),
      notes.length ? h('span', { class: `badge${fixes ? ' fix' : ''}` }, String(notes.length)) : null,
      h('span', { class: 'len' }, a.tag ?? fmtTime(a.frames, a.fps)),
    );
  }

  private renderViewBar(): void {
    this.el.views.replaceChildren(
      ...VIEWS.map((v) =>
        h(
          'button',
          {
            class: this.stage.view === v.id ? 'on' : '',
            title: `${v.label} (${v.key})`,
            onclick: () => this.setView(v.id),
          },
          v.label.replace('Three-Quarter', '¾'),
        ),
      ),
    );
    const t = (key: keyof Prefs, ic: keyof typeof ICON, title: string) =>
      h(
        'button',
        {
          class: `icon-btn${this.prefs[key] ? ' on' : ''}`,
          title,
          onclick: () => this.togglePref(key),
        },
        icon(ic),
      );
    this.el.toggles.replaceChildren(
      t('skeleton', 'bones', 'Skeleton (K)'),
      t('onion', 'onion', 'Onion skin: the frames before (blue) and after (orange) (O)'),
      t('trails', 'trails', 'Paths of the hands, feet and blade through the whole animation (J)'),
      t('ghosts', 'ghost', 'Corrected poses as green ghosts on their frames (G)'),
      t('swoosh', 'spark', 'The swoosh a swing draws in the game (W)'),
      t('outdoors', 'sun', 'Outdoors: on grass under the sky (B)'),
      h(
        'button',
        {
          class: `icon-btn${this.sheet.active ? ' on' : ''}`,
          title: 'Contact sheet: eight frames side by side, of the picked stretch or the whole (H)',
          onclick: () => (this.sheet.active ? this.endSheet() : this.showSheet()),
        },
        icon('film'),
      ),
    );
    const legend: HTMLElement[] = [];
    if (this.prefs.onion)
      legend.push(h('span', {}, h('i', { style: 'background:#58a6ff' }), 'Before'), h('span', {}, h('i', { style: 'background:#ffa94d' }), 'After'));
    if (this.prefs.ghosts && !this.editor.active && this.notesHere().some((n) => n.fix && n.frame === this.frame))
      legend.push(h('span', {}, h('i', { style: 'background:#3ddc97' }), 'Your correction'));
    if (this.editor.active) legend.push(h('span', {}, h('i', { style: 'background:#9aa4b2' }), 'As it was'));
    this.el.legend.replaceChildren(...legend);
    this.el.legend.style.display = legend.length ? '' : 'none';
  }

  /** The take's own backdrop, or the studio (outdoors, if asked). */
  private applyBackdrop(): void {
    if (this.take) this.stage.setBackdrop(this.take.backdrop ?? (this.prefs.outdoors ? 'outdoors' : 'studio'));
  }

  togglePref(key: keyof Prefs): void {
    (this.prefs as unknown as Record<string, unknown>)[key] = !this.prefs[key];
    this.savePrefs();
    if (key === 'outdoors') this.applyBackdrop();
    if (key === 'trails' && this.prefs.trails && !this.trails.built) this.buildTrails();
    this.dirty = true;
    this.renderViewBar();
  }

  setView(v: View): void {
    this.endSheet();
    this.prefs.view = v;
    this.savePrefs();
    this.stage.setView(v);
    this.renderViewBar();
    this.saveCamera();
  }

  private renderTransport(): void {
    const take = this.take;
    const b = (ic: keyof typeof ICON, title: string, on: () => void, cls = '') => h('button', { class: `icon-btn ${cls}`, title, onclick: on }, icon(ic));
    const speed = h('select', { class: 'speed', title: 'Speed (, and .)' });
    for (const s of SPEEDS) speed.add(new Option(`${s}×`, String(s), false, s === this.prefs.speed));
    speed.onchange = () => {
      this.prefs.speed = Number(speed.value);
      this.savePrefs();
    };
    const input = this.el.frameInput;
    input.value = String(this.frame);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        this.seek(Number(input.value) || 0);
        input.blur();
      }
      e.stopPropagation();
    };
    this.el.tbar.replaceChildren(
      b('first', 'First frame (Home)', () => this.seek(this.range ? this.range[0] : 0)),
      b('prev', 'Back a frame (←, Shift: 10)', () => this.step(-1)),
      h(
        'button',
        { class: 'icon-btn', title: 'Play / pause (Space)', onclick: () => this.toggle(), style: 'width:38px' },
        icon(this.playing ? 'pause' : 'play'),
      ),
      b('next', 'On a frame (→, Shift: 10)', () => this.step(1)),
      b('last', 'Last frame (End)', () => this.seek(this.range ? this.range[1] : (take?.frames ?? 1) - 1)),
      b('loop', 'Loop (L)', () => this.togglePref('loop'), this.prefs.loop ? 'on' : ''),
      speed,
      h(
        'div',
        { class: 'framebox' },
        'Frame',
        input,
        h('span', {}, `/ ${take ? take.frames - 1 : 0}`),
        h('span', { class: 'muted' }, take ? `${(this.frame / take.fps).toFixed(2)} s` : ''),
      ),
      this.range
        ? h(
            'span',
            { class: 'range-chip', title: 'The picked stretch: playback loops inside it' },
            `${this.range[0]}–${this.range[1]} (${this.range[1] - this.range[0] + 1} f)`,
            h('button', { title: 'Clear (Esc)', onclick: () => this.setRange(null) }, '✕'),
          )
        : h('span', { class: 'muted hint-range' }, 'Shift-drag to pick a stretch'),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn small', title: 'Note on this frame (N)', onclick: () => this.compose('frame') }, icon('frame'), 'Note Frame'),
      h(
        'button',
        { class: 'btn small', title: 'Note on the picked stretch (N with a stretch picked)', onclick: () => this.compose('range'), disabled: !this.range },
        icon('range'),
        'Note Range',
      ),
      h(
        'button',
        {
          class: `btn small${this.editor.active ? ' primary' : ''}`,
          title: 'Correct this frame by moving its bones (P)',
          onclick: () => (this.editor.active ? void this.saveCorrection() : this.enterEdit()),
        },
        icon('edit'),
        this.editor.active ? 'Save Correction' : 'Correct Pose',
      ),
    );
  }

  private legendKey = '';

  private renderHud(): void {
    const fixHere = this.notesHere().some((n) => n.fix && n.frame === this.frame);
    const key = `${fixHere}|${this.editor.active}|${this.prefs.onion}|${this.prefs.ghosts}`;
    if (key !== this.legendKey) {
      this.legendKey = key;
      this.renderViewBar();
    }
    const take = this.take;
    if (!take) {
      this.el.hud.textContent = '';
      return;
    }
    if (this.el.frameInput !== document.activeElement) this.el.frameInput.value = String(this.frame);
    const info = this.frame < take.baked ? take.info(this.frame) : { line: 'working it out…' };
    const phase = take.phases.find((p) => this.frame >= p.from && this.frame <= p.to);
    this.el.hud.replaceChildren(
      h('b', {}, `f ${this.frame}`),
      ` · ${(this.frame / take.fps).toFixed(2)} s · `,
      phase ? h('span', { style: `color:${PHASE_COLOURS[phase.kind] ?? '#fff'}` }, phase.label) : '',
      // The state in words, unless it only says what the band does.
      info.line.toLowerCase() === phase?.label.toLowerCase() ? '' : phase ? ' · ' : '',
      info.line.toLowerCase() === phase?.label.toLowerCase() ? '' : h('span', { class: 'state' }, info.line),
    );
    for (const label of this.el.pane.querySelectorAll<HTMLElement>('[data-frame-label]'))
      label.textContent = `${label.dataset.frameLabel || 'Frame'} ${this.frame}`;
    const timeEl = this.el.tbar.querySelector('.framebox .muted');
    if (timeEl) timeEl.textContent = `${(this.frame / take.fps).toFixed(2)} s`;
  }

  private renderBanner(): void {
    const b = this.el.banner;
    if (!this.editor.active) {
      b.style.display = 'none';
      return;
    }
    b.style.display = '';
    const n = this.editor.touched.size;
    b.replaceChildren(
      h('span', { class: 'what' }, `Correcting frame ${this.frame}`),
      h(
        'span',
        { class: 'hint' },
        this.editor.selected ? `${this.editor.selected.name} · R turn · G move · S scale · Ctrl+Z undo` : 'Click a joint to pick it',
      ),
      h('button', { class: 'btn small ghost', onclick: () => this.discardEdit() }, 'Discard'),
      h(
        'button',
        { class: 'btn small primary', onclick: () => void this.saveCorrection(), disabled: !n },
        icon('check'),
        n ? `Save Correction (${n})` : 'Save Correction',
      ),
    );
  }

  /** The selected bone's numbers, as a handle is dragged. */
  private updatePoseNumbers(): void {
    const b = this.editor.selected;
    if (!b || this.tab !== 'pose') return;
    const e = eulerDeg(readJoint(b.object));
    this.el.pane.querySelectorAll<HTMLInputElement>('.xyz input').forEach((input, i) => {
      if (input !== document.activeElement) input.value = e[i].toFixed(1);
    });
  }

  private discardEdit(): void {
    if (this.editor.dirty && !confirm('Throw away this correction?')) return;
    this.leaveEdit();
  }

  private renderTabs(): void {
    const notes = this.notesHere().filter((n) => n.status === 'open').length;
    const tab = (t: Tab, label: string, extra?: HTMLElement | null) =>
      h(
        'button',
        {
          class: this.tab === t ? 'on' : '',
          onclick: () => {
            this.tab = t;
            this.renderTabs();
          },
        },
        label,
        extra ?? null,
      );
    if (this.gallery)
      this.el.tabs.replaceChildren(
        ...[tab('about', 'About'), this.gallery.numbers ? tab('numbers', 'Numbers') : null].filter((x): x is HTMLButtonElement => !!x),
      );
    else
      this.el.tabs.replaceChildren(
        tab('notes', 'Notes', notes ? h('span', { class: 'badge' }, String(notes)) : null),
        tab('pose', 'Pose', this.editor.active ? h('span', { class: 'badge fix' }, '●') : null),
        tab('about', 'About'),
      );
    if (this.tab === 'notes') this.renderNotes();
    else if (this.tab === 'pose') this.renderPose();
    else if (this.tab === 'numbers') this.renderNumbers();
    else this.renderAbout();
  }

  /** A gallery entry's numbers (triangles and sizes, joints and costs), as it reports them. */
  renderNumbers(): void {
    if (this.tab !== 'numbers') return;
    const pane = this.el.pane;
    const scroll = pane.scrollTop;
    pane.replaceChildren();
    const acts = this.gallery?.actions?.() ?? [];
    if (acts.length)
      pane.append(
        h(
          'div',
          { class: 'tools' },
          ...acts.map((a) =>
            h(
              'button',
              {
                class: 'btn small',
                onclick: async () => {
                  toast(`${a.label}…`);
                  await a.run();
                  this.renderNumbers();
                },
              },
              a.label,
            ),
          ),
        ),
      );
    for (const t of this.gallery?.numbers?.() ?? [])
      pane.append(h('h3', {}, t.heading), h('dl', { class: 'kv' }, ...t.rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    pane.scrollTop = scroll;
  }

  renderNotes(): void {
    if (this.tab !== 'notes') return;
    const pane = this.el.pane;
    const scroll = pane.scrollTop;
    pane.replaceChildren();
    if (!this.take) return;
    // Starting a note.
    const c = this.composer;
    if (c) {
      const what =
        c.kind === 'anim'
          ? 'The whole animation'
          : c.kind === 'range'
            ? `Frames ${c.range![0]}–${c.range![1]}`
            : `Frame ${c.frame}${c.fix ? ' · corrected pose' : ''}`;
      const ta = h('textarea', {
        placeholder: c.fix ? 'What should change, in your words (optional: the pose says a lot)…' : 'What looks wrong, and what it should look like…',
      });
      ta.value = c.text;
      ta.oninput = () => (c.text = ta.value);
      ta.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void this.submitComposer();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.composer = null;
          this.renderNotes();
        }
      };
      pane.append(
        h(
          'div',
          { class: 'composer' },
          h('div', { class: 'what' }, icon(c.kind === 'anim' ? 'film' : c.kind === 'range' ? 'range' : c.fix ? 'edit' : 'frame'), what),
          c.picture ? h('img', { src: c.picture.toDataURL('image/jpeg', 0.85), alt: 'Before and after' }) : null,
          ta,
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'hint' }, h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'Enter'), ' keeps it'),
            h(
              'button',
              {
                class: 'btn small ghost',
                onclick: () => {
                  const posing = !!c.fix;
                  this.composer = null;
                  if (posing) {
                    this.tab = 'pose';
                    this.renderTabs();
                  } else this.renderNotes();
                },
              },
              c.fix ? 'Back to Posing' : 'Cancel',
            ),
            h('button', { class: 'btn small primary', onclick: () => void this.submitComposer() }, icon('check'), c.fix ? 'Keep Correction' : 'Keep Note'),
          ),
        ),
      );
      setTimeout(() => ta.focus(), 0);
    } else {
      pane.append(
        h(
          'div',
          { class: 'add-row' },
          h(
            'button',
            { class: 'btn', title: 'Note on this frame (N)', onclick: () => this.compose('frame') },
            icon('frame'),
            h('span', { 'data-frame-label': '' }, `Frame ${this.frame}`),
          ),
          h(
            'button',
            { class: 'btn', title: 'Note on the picked stretch', onclick: () => this.compose('range'), disabled: !this.range },
            icon('range'),
            this.range ? `Frames ${this.range[0]}–${this.range[1]}` : 'A Stretch',
          ),
          h('button', { class: 'btn', title: 'Note on the whole animation (Shift+N)', onclick: () => this.compose('anim') }, icon('film'), 'Whole Animation'),
        ),
      );
    }
    const notes = [...this.notesHere()].sort((a, b) => (a.status === b.status ? orderOf(a) - orderOf(b) : a.status === 'open' ? -1 : 1));
    if (!notes.length && !c)
      pane.append(
        h(
          'div',
          { class: 'callout' },
          h('p', {}, 'No notes on this animation yet.'),
          h(
            'p',
            { class: 'muted', style: 'margin:0' },
            'Pause on a frame and press ',
            h('kbd', {}, 'N'),
            ' for a note, or ',
            h('kbd', {}, 'P'),
            ' to correct the pose by moving its bones. Shift-drag the timeline to pick a stretch of frames.',
          ),
        ),
      );
    for (const n of notes) pane.append(this.noteCard(n));
    const others = store.count((n) => n.status === 'open') - notes.filter((n) => n.status === 'open').length;
    pane.append(
      h(
        'div',
        { class: 'notes-foot' },
        h('span', {}, others > 0 ? `${others} more open on other animations` : ''),
        h('button', { class: 'link', onclick: () => this.openAllNotes() }, 'All notes'),
      ),
    );
    pane.scrollTop = scroll;
  }

  private noteCard(n: Note): HTMLElement {
    const take = this.take!;
    const here = n.kind === 'frame' ? n.frame === this.frame : n.kind === 'range' ? this.frame >= n.range![0] && this.frame <= n.range![1] : false;
    const chip =
      n.kind === 'anim'
        ? h('span', { class: 'chip anim' }, 'Whole')
        : n.kind === 'range'
          ? h('span', { class: 'chip range' }, `${n.range![0]}–${n.range![1]}`)
          : h('span', { class: `chip${n.fix ? ' fix' : ''}` }, `Frame ${n.frame}`);
    const at = n.kind === 'range' ? n.range![0] : n.frame;
    const phase = at !== undefined ? take.phases.find((p) => at >= p.from && at <= p.to) : undefined;
    const editing = this.editingNote === n.id;
    const act = (ic: keyof typeof ICON, title: string, fn: () => void) =>
      h(
        'button',
        {
          class: 'icon-btn',
          title,
          onclick: (e: Event) => {
            e.stopPropagation();
            fn();
          },
        },
        icon(ic),
      );
    const card = h(
      'div',
      { class: `note${here ? ' here' : ''}${n.status === 'done' ? ' done' : ''}${editing ? ' editing' : ''}`, onclick: () => !editing && this.goToNote(n.id) },
      h(
        'div',
        { class: 'head' },
        chip,
        n.fix ? h('span', { class: 'chip fix', title: 'A corrected pose' }, 'Pose') : null,
        n.sent && n.status === 'open' ? h('span', { class: 'chip muted', title: `In a prompt ${new Date(n.sent).toLocaleString()}` }, 'Sent') : null,
        n.status === 'done' ? h('span', { class: 'chip muted' }, 'Done') : null,
        h('span', { class: 'phase' }, phase?.label ?? ''),
        h(
          'span',
          { class: 'acts' },
          act('edit', 'Edit the words', () => {
            this.editingNote = n.id;
            this.renderNotes();
          }),
          act(n.status === 'done' ? 'undo' : 'check', n.status === 'done' ? 'Open it again' : 'Mark done', () =>
            store.update(n.id, { status: n.status === 'done' ? 'open' : 'done' }),
          ),
          act('trash', this.confirmDelete === n.id ? 'Click again to delete' : 'Delete', () => {
            if (this.confirmDelete === n.id) {
              store.remove(n.id);
              this.confirmDelete = null;
            } else {
              this.confirmDelete = n.id;
              toast('Click the bin again to delete the note');
              setTimeout(() => (this.confirmDelete = null), 2500);
            }
          }),
        ),
      ),
    );
    if (editing) {
      const ta = h('textarea', {});
      ta.value = n.text;
      const save = () => {
        store.update(n.id, { text: ta.value.trim() });
        this.editingNote = null;
      };
      ta.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        if (e.key === 'Escape') {
          this.editingNote = null;
          this.renderNotes();
        }
      };
      card.append(
        ta,
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn small ghost',
              onclick: (e: Event) => {
                e.stopPropagation();
                this.editingNote = null;
                this.renderNotes();
              },
            },
            'Cancel',
          ),
          h(
            'button',
            {
              class: 'btn small primary',
              onclick: (e: Event) => {
                e.stopPropagation();
                save();
              },
            },
            'Save',
          ),
        ),
      );
      setTimeout(() => ta.focus(), 0);
    } else card.append(h('div', { class: `text${n.text ? '' : ' none'}` }, n.text || 'A corrected pose, no words'));
    if (n.fix?.image) {
      const src = store.image(n.fix.image).url;
      card.append(
        h('img', {
          src,
          alt: 'As it was and as corrected',
          loading: 'lazy',
          title: 'Bigger',
          onclick: (e: Event) => {
            e.stopPropagation();
            modal({ title: `Frame ${n.frame}: as it was and as corrected`, sub: n.text, body: h('div', { class: 'zoom' }, h('img', { src, alt: '' })) });
          },
        }),
      );
    }
    if (n.fix) {
      const m = this.measureNote(n);
      if (m) {
        const good = matches(m);
        const pct = Math.round(m.progress * 100);
        card.append(
          h(
            'div',
            {
              class: `match ${good ? 'good' : m.progress < 0.25 ? 'bad' : ''}`,
              title: `Worst bone now ${m.worstDeg.toFixed(1)}° from your pose (was ${m.wasDeg.toFixed(1)}°); worst joint ${(m.worstM * 100).toFixed(1)} cm (was ${(m.wasM * 100).toFixed(1)} cm)`,
            },
            h('span', {}, good ? 'The animation matches it' : `Animation ${m.worstDeg.toFixed(0)}° / ${(m.worstM * 100).toFixed(0)} cm off`),
            h('span', { class: 'meter' }, h('i', { style: `width:${Math.max(4, pct)}%` })),
            h('span', {}, `${pct}%`),
          ),
        );
      }
    }
    return card;
  }

  renderPose(): void {
    if (this.tab !== 'pose') return;
    const pane = this.el.pane;
    const scroll = pane.scrollTop;
    pane.replaceChildren();
    const take = this.take;
    if (!take) return;
    if (!this.editor.active) {
      pane.append(
        h(
          'div',
          { class: 'callout' },
          h('p', {}, 'Show Claude where the bones should be: pause on a frame, then move its joints.'),
          h(
            'p',
            { class: 'muted' },
            'Click a joint in the picture (or below) to pick it. ',
            h('kbd', {}, 'R'),
            ' turns it with a gizmo; ',
            h('kbd', {}, 'G'),
            ' moves a hand or a foot and bends the limb to reach. The frame as it was stays as a grey ghost.',
          ),
          h(
            'button',
            { class: 'btn primary', onclick: () => this.enterEdit() },
            icon('edit'),
            h('span', { 'data-frame-label': 'Correct Frame' }, `Correct Frame ${this.frame}`),
          ),
        ),
      );
      pane.append(h('h3', { style: 'margin-top:16px' }, 'Bones'), this.boneList(take));
      pane.scrollTop = scroll;
      return;
    }
    const ed = this.editor;
    pane.append(
      h(
        'div',
        { class: 'tools' },
        h('button', { class: `btn small${ed.tool === 'rotate' ? ' on' : ''}`, onclick: () => ed.setTool('rotate'), title: 'Turn (R)' }, icon('rotate'), 'Turn'),
        h(
          'button',
          {
            class: `btn small${ed.tool === 'move' ? ' on' : ''}`,
            onclick: () => ed.setTool('move'),
            title: 'Move: a hand or a foot reaches, others slide (G)',
          },
          icon('move'),
          'Move',
        ),
        h(
          'button',
          { class: `btn small${ed.tool === 'scale' ? ' on' : ''}`, onclick: () => ed.setTool('scale'), title: 'Squash and stretch (S)' },
          icon('scale'),
          'Scale',
        ),
        h('button', { class: 'icon-btn', title: 'Undo (Ctrl+Z)', onclick: () => ed.undo() }, icon('undo')),
        h('button', { class: 'icon-btn', title: 'Redo (Ctrl+Shift+Z)', onclick: () => ed.redo() }, icon('redo')),
      ),
    );
    const b = ed.selected;
    if (b) {
      const pose = readJoint(b.object);
      const e = eulerDeg(pose);
      const field = (axis: 'x' | 'y' | 'z', i: number) => {
        const input = h('input', { type: 'number', step: '1', value: e[i].toFixed(1) });
        input.onchange = () => {
          const next: [number, number, number] = [...e] as [number, number, number];
          next[i] = Number(input.value) || 0;
          ed.setEuler(next);
        };
        input.onkeydown = (ev) => ev.stopPropagation();
        return h('label', { class: axis }, h('b', {}, axis.toUpperCase()), input, '°');
      };
      take.root.updateMatrixWorld(true);
      const model = modelPositions(take)[b.name] ?? [0, 0, 0];
      const chain = ed.chainOf(b);
      pane.append(
        h(
          'div',
          { class: 'bone-card' },
          h(
            'div',
            { class: 'title' },
            h('span', { class: 'sw', style: `background:#${SIDE_COLOURS[b.side].toString(16).padStart(6, '0')}` }),
            b.name,
            h('span', { class: 'muted', style: 'font-weight:400;font-size:12px' }, b.parent ? `in ${b.parent}` : ''),
          ),
          h('div', { class: 'xyz' }, field('x', 0), field('y', 1), field('z', 2)),
          h('div', { class: 'readout' }, `Turn in its parent's space (XYZ). Joint at ${model.map((v) => v.toFixed(3)).join(', ')} m in the body.`),
          h(
            'div',
            { class: 'readout' },
            ed.tool === 'move'
              ? chain
                ? `Move bends ${chain[0].name} and ${chain[1].name} to reach.`
                : 'Move slides this joint.'
              : ed.tool === 'scale'
                ? `Scale ${b.object.scale
                    .toArray()
                    .map((v) => v.toFixed(2))
                    .join(' × ')}: drag a handle, or the centre for all three.`
                : 'Drag the gizmo’s rings to turn it.',
          ),
          h(
            'div',
            { class: 'row', style: 'display:flex;gap:6px;margin-top:8px' },
            h('button', { class: 'btn small', onclick: () => ed.reset(b), disabled: !ed.touched.has(b.name) }, icon('reset'), 'Reset Bone'),
            h('button', { class: 'btn small', onclick: () => ed.reset(), disabled: !ed.dirty }, 'Reset All'),
          ),
        ),
      );
    } else
      pane.append(h('div', { class: 'callout', style: 'margin-bottom:12px' }, h('p', { style: 'margin:0' }, 'Click a joint in the picture, or a bone below.')));
    pane.append(
      h(
        'div',
        { style: 'display:flex;gap:6px;margin-bottom:14px' },
        h(
          'button',
          { class: 'btn primary', style: 'flex:1', onclick: () => void this.saveCorrection(), disabled: !ed.dirty },
          icon('check'),
          'Save Correction…',
        ),
        h('button', { class: 'btn', onclick: () => this.discardEdit() }, 'Discard'),
      ),
    );
    pane.append(h('h3', {}, 'Bones'), this.boneList(take));
    pane.scrollTop = scroll;
  }

  private boneList(take: Take): HTMLElement {
    const list = h('div', { class: 'bone-list' });
    const depth = new Map<string, number>();
    for (const b of take.bones) depth.set(b.name, b.parent ? (depth.get(b.parent) ?? 0) + 1 : 0);
    for (const b of take.bones) {
      const on = this.editor.selected?.name === b.name;
      list.append(
        h(
          'button',
          {
            class: `bone-row${on ? ' on' : ''}${b.locked ? ' locked' : ''}`,
            style: `padding-left:${8 + Math.min(10, depth.get(b.name) ?? 0) * 10}px`,
            title: b.locked ? 'Not for posing' : '',
            onclick: () => {
              if (b.locked) return;
              if (!this.editor.active) this.enterEdit(b);
              else this.editor.select(b);
            },
          },
          h('span', { class: 'sw', style: `background:#${SIDE_COLOURS[b.side].toString(16).padStart(6, '0')}` }),
          b.name,
          this.editor.touched.has(b.name) ? h('span', { class: 'touched' }, 'moved') : null,
        ),
      );
    }
    return list;
  }

  renderAbout(): void {
    if (this.tab !== 'about') return;
    const pane = this.el.pane;
    pane.replaceChildren();
    const take = this.take;
    const s = this.subject;
    const a = this.anim;
    if (!s || !a) return;
    const src = s.source(this.options);
    const link = h(
      'button',
      {
        class: 'link',
        onclick: () =>
          void navigator.clipboard
            .writeText(linkTo(location.origin, s.id, a.id, this.liveOptions(), take ? this.frame : undefined))
            .then(() => toast('Link copied', 'good')),
      },
      take ? 'Copy a link to this frame' : 'Copy a link to this',
    );
    const how = [
      h('h3', { style: 'margin-top:16px' }, `How ${s.name} ${take ? 'Moves' : 'Is Made'}`),
      h('p', { class: 'about-text' }, src.system),
      h('ul', { class: 'files' }, ...src.files.map((f) => h('li', {}, h('code', {}, f.path), h('span', {}, f.what)))),
      src.conventions ? h('h3', {}, 'Conventions') : null,
      src.conventions ? h('p', { class: 'about-text' }, src.conventions) : null,
    ].filter((x): x is NonNullable<typeof x> => !!x);
    if (!take) {
      pane.append(
        h('h3', {}, 'This One'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, 'Name'),
          h('dd', {}, `${a.label} (${a.id})`),
          h('dt', {}, 'Made by'),
          h('dd', {}, s.animSource(a.id, this.options)),
          h('dt', {}, 'Link'),
          h('dd', {}, link),
        ),
        ...how,
      );
      return;
    }
    const info = this.frame < take.baked ? take.info(this.frame) : null;
    pane.append(
      h('h3', {}, 'This Animation'),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Name'),
        h('dd', {}, `${a.label} (${a.id})`),
        h('dt', {}, 'Length'),
        h('dd', {}, `${take.frames} frames at ${take.fps} fps · ${fmtTime(take.frames, take.fps)}${take.loop ? ' · loops' : ''}`),
        h('dt', {}, 'Made by'),
        h('dd', {}, s.animSource(a.id, this.options)),
        h('dt', {}, 'Bones'),
        h('dd', {}, `${take.bones.length} (${take.bones.filter((b) => !b.minor && !b.name.startsWith('@')).length} drawn)`),
        h('dt', {}, 'Link'),
        h('dd', {}, link),
      ),
      h('h3', {}, `Frame ${this.frame}`),
      info ? h('pre', { class: 'detail' }, `${info.line}\n\n${JSON.stringify(info.detail ?? {}, null, 1)}`) : h('p', { class: 'muted' }, 'Working it out…'),
      ...how,
    );
  }

  /** The options as the address carries them: those with no value left out. */
  private liveOptions(): Options {
    return Object.fromEntries(Object.entries(this.options).filter(([, v]) => v !== ''));
  }

  // ---------- other windows ----------

  openAllNotes(): void {
    const body = h('div', { class: 'all-notes' });
    let close = () => {};
    const draw = () => {
      body.replaceChildren();
      const groups = new Map<string, Note[]>();
      for (const n of store.notes) {
        const k = `${n.subjectName} · ${n.animLabel}`;
        groups.set(k, [...(groups.get(k) ?? []), n]);
      }
      if (!groups.size) body.append(h('div', { class: 'empty' }, 'No notes yet.'));
      for (const [k, list] of groups) {
        const open = list.filter((n) => n.status === 'open').length;
        body.append(
          h(
            'div',
            { class: 'group' },
            h('h4', {}, k, open ? h('span', { class: 'badge' }, String(open)) : h('span', { class: 'chip muted' }, 'All done')),
            ...list
              .sort((a, b) => orderOf(a) - orderOf(b))
              .map((n) =>
                h(
                  'div',
                  {
                    class: 'row',
                    onclick: () => {
                      close();
                      this.goToNote(n.id);
                    },
                  },
                  h(
                    'span',
                    { class: `chip${n.kind === 'range' ? ' range' : n.kind === 'anim' ? ' anim' : n.fix ? ' fix' : ''}` },
                    n.kind === 'anim' ? 'Whole' : n.kind === 'range' ? `${n.range![0]}–${n.range![1]}` : `Frame ${n.frame}`,
                  ),
                  h('span', { class: 't' }, n.text || (n.fix ? 'A corrected pose' : '')),
                  n.status === 'done' ? h('span', { class: 'chip muted' }, 'Done') : null,
                ),
              ),
          ),
        );
      }
    };
    draw();
    close = modal({
      title: 'All Notes',
      sub: `${store.count((n) => n.status === 'open')} open, ${store.count((n) => n.status === 'done')} done`,
      body,
      foot: [
        h(
          'span',
          { class: 'grow' },
          store.dir ? `Kept in ${store.dir}` : 'Kept in this browser only: the development server (npm run dev) keeps them as files, pictures and all.',
        ),
        h(
          'button',
          {
            class: 'btn danger',
            onclick: () => {
              const k = store.clearDone();
              toast(`${k} done ${k === 1 ? 'note' : 'notes'} cleared`);
              draw();
            },
          },
          icon('trash'),
          'Clear Done Notes',
        ),
      ],
    });
  }

  openHelp(): void {
    const row = (k: string, what: string) => h('div', {}, h('span', {}, what), h('span', {}, ...k.split(' ').map((x) => h('kbd', {}, x))));
    modal({
      title: 'Keyboard',
      narrow: true,
      body: h(
        'div',
        { class: 'keys' },
        h('h4', {}, 'Playing'),
        row('Space', 'Play / pause'),
        row('← →', 'A frame back / on'),
        row('Shift+← Shift+→', 'Ten frames'),
        row('Home End', 'First / last frame'),
        row(', .', 'Slower / faster'),
        row('L', 'Loop'),
        row('[ ]', 'Stretch starts / ends here'),
        row('Esc', 'Clear the stretch'),
        h('h4', {}, 'Looking'),
        row('1 2 3 4 5 6', 'Camera: ¾, front, sides, behind, above'),
        row('F', 'Frame the body again'),
        row('K', 'Skeleton'),
        row('O', 'Onion skin'),
        row('J', 'Paths of hands and feet'),
        row('W', 'The swing’s swoosh'),
        row('B', 'Outdoors or in the studio'),
        row('H', 'Contact sheet: eight frames side by side'),
        row('G', 'Correction ghosts (when not posing)'),
        h('h4', {}, 'Notes'),
        row('N', 'Note on this frame (or the stretch)'),
        row('Shift+N', 'Note on the whole animation'),
        row('Ctrl+Enter', 'Keep the note / Create Prompt'),
        h('h4', {}, 'Correcting a pose'),
        row('P', 'Start (or click a joint)'),
        row('R', 'Turn the joint'),
        row('G', 'Move: a hand or foot reaches'),
        row('S', 'Squash and stretch'),
        row('X Y Z', 'Nudge 5° about its axis (Shift: back)'),
        row('Ctrl+Z Ctrl+Shift+Z', 'Undo / redo'),
        row('Enter', 'Save the correction'),
        row('Esc', 'Discard it'),
      ),
    });
  }

  // ---------- input ----------

  private bindPointer(): void {
    const canvas = this.stage.renderer.domElement;
    let down: { x: number; y: number; hot: boolean } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, hot: this.editor.hot };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (down || !this.take) return;
      const r = canvas.getBoundingClientRect();
      const b = this.skeleton.visible ? this.skeleton.pick(this.stage, e.clientX - r.left, e.clientY - r.top) : null;
      const name = b?.name ?? null;
      canvas.style.cursor = name && !this.editor.hot ? 'pointer' : '';
      if (name !== this.skeleton.hovered) {
        this.skeleton.hovered = name;
        this.skeleton.update();
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.hot || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return;
      const r = canvas.getBoundingClientRect();
      const b = this.skeleton.visible ? this.skeleton.pick(this.stage, e.clientX - r.left, e.clientY - r.top) : null;
      if (b && !b.locked) {
        if (!this.editor.active) this.enterEdit(b);
        else this.editor.select(b);
      } else if (this.editor.active && !b) this.editor.select(null);
    });
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (document.querySelector('.scrim')) return;
      const k = e.key;
      const ed = this.editor;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k.toLowerCase() === 'z') {
        if (ed.active) e.shiftKey ? ed.redo() : ed.undo();
        e.preventDefault();
        return;
      }
      if (mod && k.toLowerCase() === 'y') {
        if (ed.active) ed.redo();
        e.preventDefault();
        return;
      }
      if (mod && k === 'Enter') {
        void this.openPrompt();
        e.preventDefault();
        return;
      }
      if (mod) return;
      let used = true;
      switch (k) {
        case ' ':
          this.toggle();
          break;
        case 'ArrowLeft':
          this.step(e.shiftKey ? -10 : -1);
          break;
        case 'ArrowRight':
          this.step(e.shiftKey ? 10 : 1);
          break;
        case 'Home':
          this.seek(this.range ? this.range[0] : 0);
          break;
        case 'End':
          this.seek(this.range ? this.range[1] : (this.take?.frames ?? 1) - 1);
          break;
        case '[':
          this.setRange([this.frame, this.range ? Math.max(this.range[1], this.frame) : this.frame]);
          break;
        case ']':
          this.setRange([this.range ? Math.min(this.range[0], this.frame) : this.frame, this.frame]);
          break;
        case 'Escape':
          if (ed.active) this.discardEdit();
          else if (this.composer) {
            this.composer = null;
            this.renderNotes();
          } else this.setRange(null);
          break;
        case 'Enter':
          if (ed.active) void this.saveCorrection();
          else used = false;
          break;
        case ',':
        case '<':
          this.nudgeSpeed(-1);
          break;
        case '.':
        case '>':
          this.nudgeSpeed(1);
          break;
        case '?':
          this.openHelp();
          break;
        default:
          used = this.letter(k, e.shiftKey);
      }
      if (used) e.preventDefault();
    });
  }

  private letter(k: string, shift: boolean): boolean {
    const ed = this.editor;
    const view = VIEWS.find((v) => v.key === k);
    if (view) {
      this.setView(view.id);
      return true;
    }
    switch (k.toLowerCase()) {
      case 'l':
        this.togglePref('loop');
        this.renderTransport();
        return true;
      case 'k':
        this.togglePref('skeleton');
        return true;
      case 'o':
        this.togglePref('onion');
        return true;
      case 'j':
        this.togglePref('trails');
        return true;
      case 'w':
        this.togglePref('swoosh');
        return true;
      case 'b':
        this.togglePref('outdoors');
        return true;
      case 'h':
        if (this.sheet.active) this.endSheet();
        else this.showSheet();
        return true;
      case 'f':
        if (this.take) this.stage.frame(this.take.framing, this.stage.view);
        return true;
      case 'n':
        this.compose(shift ? 'anim' : this.range && !(this.frame >= 0 && this.range[0] === this.range[1]) ? 'range' : 'frame');
        return true;
      case 'p':
        if (ed.active) void this.saveCorrection();
        else this.enterEdit();
        return true;
      case 'r':
        if (ed.active) ed.setTool('rotate');
        return ed.active;
      case 's':
        if (ed.active) ed.setTool('scale');
        return ed.active;
      case 'g':
        if (ed.active) ed.setTool('move');
        else this.togglePref('ghosts');
        return true;
      case 'x':
      case 'y':
      case 'z':
        if (ed.active && ed.selected) ed.nudge(k.toLowerCase() as 'x' | 'y' | 'z', shift ? -5 : 5);
        return ed.active;
    }
    return false;
  }

  private nudgeSpeed(d: number): void {
    const i = SPEEDS.indexOf(this.prefs.speed);
    this.prefs.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 4 : i) + d))];
    this.savePrefs();
    this.renderTransport();
    toast(`Speed ${this.prefs.speed}×`);
  }

  // ---------- keeping state across reloads ----------

  private savePrefs(): void {
    localStorage.setItem(PREFS, JSON.stringify(this.prefs));
  }

  private hashTimer = 0;
  private writeHashSoon(): void {
    clearTimeout(this.hashTimer);
    this.hashTimer = window.setTimeout(() => this.writeHash(), 200);
  }

  private writeHash(): void {
    if (!this.subject || !this.anim) return;
    const q = new URLSearchParams(this.liveOptions());
    if (this.frame) q.set('f', String(this.frame));
    if (this.range) q.set('r', `${this.range[0]}-${this.range[1]}`);
    const s = q.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}#/${this.subject.id}/${this.anim.id}${s ? `?${s}` : ''}`);
  }

  private saveCamera(): void {
    if (!this.subject || !this.anim) return;
    sessionStorage.setItem(CAMERA, JSON.stringify({ key: `${this.subject.id}/${this.anim.id}`, ...this.stage.cameraState() }));
  }

  private savedCamera(): { position: [number, number, number]; target: [number, number, number] } | null {
    try {
      const s = JSON.parse(sessionStorage.getItem(CAMERA) ?? 'null') as {
        key: string;
        position: [number, number, number];
        target: [number, number, number];
      } | null;
      return s && s.key === `${this.subject?.id}/${this.anim?.id}` ? s : null;
    } catch {
      return null;
    }
  }

  /** Opens what the address says (#/subject/anim?option=value&f=frame&r=from-to), or the hero. */
  async route(): Promise<void> {
    const m = /^#\/([^/?]+)\/([^?]+)(?:\?(.*))?$/.exec(location.hash);
    if (!m) {
      await this.open('hero', 'idle');
      this.libView = 'subjects';
      this.renderLibrary();
      return;
    }
    if (!subjectById(decodeURIComponent(m[1]))) {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      await this.route();
      return;
    }
    const q = new URLSearchParams(m[3] ?? '');
    const frame = Number(q.get('f') ?? 0) || 0;
    const r = q.get('r')?.split('-').map(Number);
    q.delete('f');
    q.delete('r');
    await this.open(decodeURIComponent(m[1]), decodeURIComponent(m[2]), Object.fromEntries(q), frame, { range: r && r.length === 2 ? [r[0], r[1]] : null });
    this.playing = false;
    this.renderTransport();
  }

  /** Thumbnails for the list, made in the background (of what moves: a gallery shows its initial). */
  async makeThumbs(): Promise<void> {
    await thumbnails(SUBJECTS, (id, url) => this.setThumb(id, url));
  }

  // ---------- for tests and the review check (window.__library) ----------

  /** Keeps the pose being corrected as a note with these words; returns its id. */
  async keepCorrection(text: string): Promise<string | null> {
    await this.saveCorrection();
    if (!this.composer?.fix) return null;
    this.composer.text = text;
    await this.submitComposer();
    return store.notes[store.notes.length - 1]?.id ?? null;
  }

  async addNote(kind: NoteKind, text: string, range?: [number, number]): Promise<string | null> {
    if (range) this.setRange(range);
    this.compose(kind);
    if (!this.composer) return null;
    this.composer.text = text;
    await this.submitComposer();
    return store.notes[store.notes.length - 1]?.id ?? null;
  }

  /**
   * A correction against the code as it is now: opens its frame from where it was made, measures how
   * far the pose is from it, and draws the frame with the correction's ghost over it.
   */
  async checkNote(n: Note): Promise<{ measure: Measure | null; image: string; frames: number }> {
    await this.open(n.subject, n.anim, n.options, n.frame ?? n.range?.[0] ?? 0);
    const take = this.take!;
    while (!take.bake(240)) {
      /* bake */
    }
    this.pause();
    this.frame = Math.min(take.frames - 1, n.frame ?? 0);
    const rig = take.ghost();
    const m = measure(take, rig, n);
    rig.dispose();
    if (n.fix?.camera) this.stage.setCamera(n.fix.camera);
    // The note's own ghost, whatever is in the store.
    const kept = this.prefs.ghosts;
    this.prefs.ghosts = false;
    this.present();
    this.ghosts.begin();
    if (n.fix) this.ghosts.next(GHOST.target.color, GHOST.target.opacity)?.apply(n.fix.after);
    this.ghosts.end();
    const overlay = this.stage.overlay.visible;
    this.stage.overlay.visible = false;
    take.setDecor?.(false);
    const image = this.stage.snapshot().toDataURL('image/png');
    this.stage.overlay.visible = overlay;
    this.prefs.ghosts = kept;
    this.dirty = true;
    return { measure: m, image, frames: take.frames };
  }
}

function orderOf(n: Note): number {
  return n.kind === 'anim' ? -1 : n.kind === 'range' ? n.range![0] : (n.frame ?? 0);
}

function round3(r: Record<string, number[]>): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const [k, v] of Object.entries(r)) out[k] = [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000];
  return out;
}

/** Four pictures in a two by two grid, each labelled, scaled to a sensible size. */
function compose(shots: HTMLCanvasElement[], labels: string[], secondView: string): HTMLCanvasElement {
  const w = Math.min(760, shots[0].width);
  const k = w / shots[0].width;
  const hh = Math.round(shots[0].height * k);
  const bar = 26;
  const c = document.createElement('canvas');
  c.width = w * 2;
  c.height = (hh + bar) * 2;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0f1116';
  g.fillRect(0, 0, c.width, c.height);
  shots.forEach((s, i) => {
    const x = (i % 2) * w;
    const y = Math.floor(i / 2) * (hh + bar);
    g.drawImage(s, x, y + bar, w, hh);
    g.fillStyle = i % 2 ? '#123726' : '#1c2029';
    g.fillRect(x, y, w, bar);
    g.fillStyle = i % 2 ? '#3ddc97' : '#cfd7e6';
    g.font = '600 13px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(i >= 2 && i % 2 === 0 ? labels[i].replace('From the side', `From the ${secondView.toLowerCase()}`) : labels[i], x + 10, y + bar / 2);
  });
  g.fillStyle = '#2a303d';
  g.fillRect(w - 1, 0, 2, c.height);
  return c;
}

void THREE;
