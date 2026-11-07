import { Address } from './address';
import { setToastHost, toast } from './dom';
import { Editor } from './editor';
import { Ghosts } from './ghosts';
import { bindKeys, bindPointer } from './input';
import { type Layout, layout } from './layout';
import { openAllNotes, openHelp } from './modals';
import { Notes } from './notes';
import { Skeleton, Trails } from './overlay';
import { Bars } from './panels/bars';
import { Browser } from './panels/browser';
import { NotesTab } from './panels/notesTab';
import { PoseTab } from './panels/poseTab';
import { Side } from './panels/side';
import { Playback } from './playback';
import { Posing } from './posing';
import { loadPrefs, type Prefs, saveCamera, savedCamera, savePrefs } from './prefs';
import { openPrompt } from './prompts';
import { Sheet } from './sheet';
import { Stage, type View } from './stage';
import { noteKey, store } from './store';
import { subjectById } from './subjects';
import { Timeline } from './timeline';
import type { AnimDef, Gallery, Options, Subject, Take } from './types';

// The content library: pick something, then one of its animations; play it, scrub it, step it a
// frame at a time; leave notes on the whole of it, on a stretch of frames or on one frame, and on a
// frame put the bones where they should have been. "Create Prompt" turns the open notes into one
// prompt for Claude (prompt.ts); the corrected poses stay on screen as ghosts on their frames, so
// once Claude has changed the code (the page reloads by itself) you can see how close it came. A
// gallery (every model, the buildings, a crowd) is drawn in a scene of its own in the same place,
// with its options on the left and its numbers on the right.
//
// App holds what is open (the subject, its options, the animation and its take, or a gallery's
// entry; the frame, the stretch picked, whether it plays) and opens things, keeping the last few
// takes. Its parts do the rest, each seeing the others through it: playing (playback.ts),
// correcting a pose (posing.ts), notes (notes.ts), prompts (prompts.ts), the address (address.ts),
// the keys and the pointer (input.ts), the windows (modals.ts), and the panels (panels/: the list on
// the left, the bars round the picture, the side panel and its Notes and Pose tabs). The page itself
// is layout.ts; window.__library (api.ts) drives it in tests.

/** The side panel's tabs. */
export type Tab = 'notes' | 'pose' | 'about' | 'numbers';

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
  /** The page's elements the parts fill. */
  readonly el: Layout;

  subject: Subject | null = null;
  options: Options = {};
  anim: AnimDef | null = null;
  take: Take | null = null;
  /** The gallery entry in the viewport instead of a take, if one is open. */
  gallery: Gallery | null = null;
  frame = 0;
  playing = true;
  range: [number, number] | null = null;
  /** The side panel's open tab. */
  tab: Tab = 'notes';
  /** Frames drawn so far: what tests wait on, never a fixed time. */
  frameCount = 0;

  readonly playback: Playback;
  readonly posing: Posing;
  readonly notes: Notes;
  readonly address: Address;
  readonly browser: Browser;
  readonly bars: Bars;
  readonly side: Side;
  readonly notesTab: NotesTab;
  readonly poseTab: PoseTab;

  private takes = new Map<string, Take>();
  private opening = 0;

  constructor(private readonly host: HTMLElement) {
    this.playback = new Playback(this);
    this.posing = new Posing(this);
    this.notes = new Notes(this);
    this.address = new Address(this);
    this.browser = new Browser(this);
    this.bars = new Bars(this);
    this.side = new Side(this);
    this.notesTab = new NotesTab(this);
    this.poseTab = new PoseTab(this);
    this.el = layout(host, this.timeline.el, {
      prompt: () => void openPrompt(this),
      help: () => openHelp(),
      allNotes: () => openAllNotes(this),
      search: (q) => {
        this.browser.search = q;
        this.browser.render();
      },
    });
    setToastHost(this.el.toasts);

    this.stage = new Stage(this.el.viewport);
    this.stage.overlay.add(this.skeleton.group, this.trails.group);
    this.editor = new Editor(this.stage);
    this.editor.onChange = () => {
      this.skeleton.selected = this.editor.selected?.name ?? null;
      this.skeleton.update();
      this.editor.sync();
      if (this.editor.isDragging) {
        this.poseTab.updateNumbers();
        return;
      }
      this.bars.renderBanner();
      if (this.tab === 'pose') this.poseTab.render();
    };
    this.editor.gizmo.addEventListener('dragging-changed', () => {
      if (this.editor.isDragging) return;
      this.bars.renderBanner();
      if (this.tab === 'pose') this.poseTab.render();
    });
    this.ghosts = new Ghosts(this.stage);
    this.sheet = new Sheet(this.stage);
    this.stage.controls.addEventListener('change', () => this.saveCamera());

    this.timeline.onSeek = (f) => this.playback.seek(f);
    this.timeline.onScrubStart = () => this.playback.pause();
    this.timeline.onRange = (r) => {
      this.range = r;
      this.bars.renderTransport();
    };
    this.timeline.onMarker = (id) => this.notes.goTo(id);

    bindPointer(this);
    bindKeys(this);
    store.on(() => this.notes.changed());
    // A link pasted into this tab opens what it names.
    window.addEventListener('hashchange', () => void this.address.route());
    this.renderAll();
    this.playback.start();
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
      this.posing.leave();
    }
    this.playback.endSheet();
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
    this.browser.view = 'anims';
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
      this.notes.forget();
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
    this.playback.restart();
    this.notes.composer = null;
    this.notes.editing = null;
    this.redraw();
    this.notes.updateMarkers();
    this.renderAll();
    this.address.write();
  }

  /** Puts a gallery entry in the viewport in place of the take: its own picture, options and numbers. */
  private showGallery(g: Gallery): void {
    this.closeGallery();
    this.stage.bodies.clear();
    this.take = null;
    this.ghosts.reset(null);
    this.notes.forget();
    this.trails.clear();
    this.skeleton.setBody(null);
    this.gallery = g;
    this.el.viewport.prepend(g.el);
    this.host.classList.add('gallery-open');
    if (this.tab !== 'numbers' || !g.numbers) this.tab = 'about';
    this.notes.composer = null;
    this.notes.editing = null;
    this.range = null;
    this.frame = 0;
    this.renderAll();
    this.address.write();
  }

  private closeGallery(): void {
    if (!this.gallery) return;
    this.gallery.dispose();
    this.gallery.el.remove();
    this.gallery = null;
    this.host.classList.remove('gallery-open');
    if (this.tab === 'numbers') this.tab = 'notes';
  }

  /** Draws the frame again (after something outside the loop worked frames out). */
  redraw(): void {
    this.playback.dirty = true;
  }

  // ---------- the panels, the view and the toggles ----------

  renderAll(): void {
    this.bars.renderCrumbs();
    this.bars.renderCount();
    this.browser.render();
    this.bars.renderViewBar();
    this.bars.renderTransport();
    this.side.render();
    this.bars.renderBanner();
    this.bars.renderHud();
  }

  /** The take's own backdrop, or the studio (outdoors, if asked). */
  private applyBackdrop(): void {
    if (this.take) this.stage.setBackdrop(this.take.backdrop ?? (this.prefs.outdoors ? 'outdoors' : 'studio'));
  }

  togglePref(key: keyof Prefs): void {
    (this.prefs as unknown as Record<string, unknown>)[key] = !this.prefs[key];
    savePrefs(this.prefs);
    if (key === 'outdoors') this.applyBackdrop();
    if (key === 'trails' && this.prefs.trails && !this.trails.built) this.playback.buildTrails();
    this.redraw();
    this.bars.renderViewBar();
  }

  setView(v: View): void {
    this.playback.endSheet();
    this.prefs.view = v;
    savePrefs(this.prefs);
    this.stage.setView(v);
    this.bars.renderViewBar();
    this.saveCamera();
  }

  /** Keeps where the camera is on the animation open, so a reload comes back to the same picture. */
  private saveCamera(): void {
    if (!this.subject || !this.anim) return;
    saveCamera(`${this.subject.id}/${this.anim.id}`, this.stage.cameraState());
  }

  private savedCamera(): ReturnType<typeof savedCamera> {
    return savedCamera(`${this.subject?.id}/${this.anim?.id}`);
  }
}
