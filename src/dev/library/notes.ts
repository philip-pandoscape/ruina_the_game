import type { App } from './app';
import { toast } from './dom';
import { measure, type Measure } from './measure';
import { newId, noteKey, store, type Note, type NoteKind, type PoseFix } from './store';
import type { Marker } from './timeline';
import type { Posable } from './types';

// Notes on what's open (the store keeps them, store.ts; the Notes tab draws them,
// panels/notesTab.ts): those on this animation with these options, their marks on the timeline,
// the note being written (the composer: on the whole animation, a stretch or a frame, with a
// corrected pose and its picture), keeping it, going to a note wherever it is, and how close the
// code's pose now comes to a correction.

/** A note being written. */
export interface Composer {
  kind: NoteKind;
  frame?: number;
  range?: [number, number];
  fix?: PoseFix;
  picture?: HTMLCanvasElement;
  text: string;
}

/** Where a note sits in a list: the whole animation first, then by frame. */
export function orderOf(n: Note): number {
  return n.kind === 'anim' ? -1 : n.kind === 'range' ? n.range![0] : (n.frame ?? 0);
}

export class Notes {
  /** The note being written, if one is. */
  composer: Composer | null = null;
  /** The note whose words are being edited in its card. */
  editing: string | null = null;
  /** The note whose bin was pressed once: a second press deletes it. */
  confirmDelete: string | null = null;
  private measureRig: Posable | null = null;
  private measures = new Map<string, Measure | null>();

  constructor(private readonly app: App) {}

  /** The notes on the animation open, with the options that make a difference to it. */
  here(): Note[] {
    const app = this.app;
    if (!app.subject || !app.anim) return [];
    return store.forAnim(app.subject.id, app.anim.id, app.keyed(app.subject.id, app.anim.id, app.options));
  }

  /** The store changed (here or in another tab): everything that shows notes is drawn again. */
  changed(): void {
    const app = this.app;
    this.updateMarkers();
    app.bars.renderCount();
    if (app.tab === 'notes') app.notesTab.render();
    app.browser.render();
    app.redraw();
  }

  updateMarkers(): void {
    const timeline = this.app.timeline;
    timeline.markers = this.here().map(
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
    timeline.draw();
  }

  /** Starts a note on the whole animation, the picked stretch or the frame (while posing: keeps the correction). */
  compose(kind: NoteKind): void {
    const app = this.app;
    if (!app.take) return;
    if (app.editor.active && kind === 'frame') {
      void app.posing.save();
      return;
    }
    if (kind === 'range' && !app.range) {
      toast('Pick a stretch first: shift-drag on the timeline, or [ and ] at its ends', 'warn');
      return;
    }
    app.playback.pause();
    this.composer = { kind, frame: kind === 'frame' ? app.frame : undefined, range: kind === 'range' ? app.range! : undefined, text: '' };
    app.tab = 'notes';
    app.renderAll();
  }

  /** Keeps the note being written, with its picture. */
  async submit(): Promise<void> {
    const app = this.app;
    const c = this.composer;
    const take = app.take;
    if (!c || !take || !app.subject || !app.anim) return;
    if (!c.text.trim() && !c.fix) {
      toast('Say what is wrong, in a few words', 'warn');
      return;
    }
    const id = newId();
    const at = c.kind === 'frame' ? c.frame! : c.kind === 'range' ? c.range![0] : null;
    const note: Note = {
      id,
      subject: app.subject.id,
      subjectName: app.subject.name,
      options: app.keyed(app.subject.id, app.anim.id, app.options),
      anim: app.anim.id,
      animLabel: app.anim.label,
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
    if (app.editor.active) app.posing.leave();
    toast(note.fix ? 'Correction kept: it shows as a green ghost on its frame' : 'Note kept', 'good');
    app.renderAll();
  }

  /** Shows a note: on its frame or stretch, opening its animation first if another is open. */
  goTo(id: string): void {
    const app = this.app;
    const n = store.notes.find((x) => x.id === id);
    if (!n) return;
    if (
      n.subject !== app.subject?.id ||
      n.anim !== app.anim?.id ||
      noteKey(n.subject, n.anim, n.options) !== noteKey(n.subject, n.anim, app.keyed(n.subject, n.anim, app.options))
    ) {
      void app.open(n.subject, n.anim, { ...app.options, ...n.options }, n.frame ?? n.range?.[0] ?? 0, { range: n.range ?? null });
      return;
    }
    app.playback.pause();
    if (n.kind === 'range') {
      app.playback.setRange(n.range!);
      app.playback.seek(n.range![0]);
    } else if (n.kind === 'frame') app.playback.seek(n.frame!);
    if (n.fix && n.fix.camera) app.stage.setCamera(n.fix.camera);
  }

  /** How close the code's pose comes to a note's correction (null until the take is worked out). */
  measure(n: Note): Measure | null {
    const take = this.app.take;
    if (!take || !n.fix || n.frame === undefined || take.baked <= n.frame) return null;
    if (this.measures.has(n.id)) return this.measures.get(n.id)!;
    this.measureRig ??= take.ghost();
    const m = measure(take, this.measureRig, n);
    this.measures.set(n.id, m);
    return m;
  }

  /** Every frame of the take is worked out: corrections are measured again. */
  remeasure(): void {
    this.measures.clear();
  }

  /** Another take (or a gallery) is on screen: what was measured on the last one goes. */
  forget(): void {
    this.measureRig?.dispose();
    this.measureRig = null;
    this.measures.clear();
  }
}
