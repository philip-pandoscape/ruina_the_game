import type { App } from './app';
import * as heroBench from './bench/hero';
import { measure, type Measure } from './measure';
import { GHOST } from './overlay';
import { promptText, type Scope } from './prompts';
import type { SheetOptions } from './sheet';
import { store, type Note, type NoteKind } from './store';
import { SUBJECTS } from './subjects';

// window.__library: what the tests drive the library with (its own, tests/integration/library.spec.ts;
// and those of what it shows: models.spec.ts and the rest) and what the review check
// (tests/integration/library-review.spec.ts) measures corrections with. `app` is the library itself,
// for what the tests read off it (frameCount, prefs, the stage's backdrop, the contact sheet).

/** The hero's bench as a whole, as __library.measure: the specs call any of it (knip sees this as using all of it). */
const bench = heroBench;

export function libraryApi(app: App) {
  return {
    ready: false,
    app,
    subjects: () =>
      SUBJECTS.map((s) => ({
        id: s.id,
        name: s.name,
        group: s.group,
        anims: s.anims(app.defaults(s)).map((a) => ({ id: a.id, label: a.label, frames: a.frames, fps: a.fps })),
      })),
    open: (subject: string, anim: string, options: Record<string, string> = {}, frame = 0) => app.open(subject, anim, options, frame),
    state: () => ({
      subject: app.subject?.id ?? null,
      anim: app.anim?.id ?? null,
      frame: app.frame,
      frames: app.take?.frames ?? 0,
      baked: app.take?.baked ?? 0,
      playing: app.playing,
      editing: app.editor.active,
      touched: [...app.editor.touched],
      range: app.range,
      /** A gallery entry is open (not a take), and has loaded all it loads. */
      gallery: !!app.gallery,
      ready: app.gallery ? app.gallery.ready() : !!app.take,
    }),
    /** The open gallery entry's own calls (models: stats, probe, ray, seaInside...), or null. */
    gallery: () => app.gallery?.api ?? null,
    /** The take on screen, for what a subject measures on it (a library clip's error), or null. */
    take: () => app.take,
    seek: (f: number) => app.playback.seek(f),
    play: () => app.playback.play(),
    pause: () => app.playback.pause(),
    bakeAll: () => {
      const t = app.take;
      if (t)
        while (!t.bake(240)) {
          /* bake */
        }
      app.redraw();
    },
    /** A contact sheet of the animation on screen (frames, or count spread over from..to); returns its frames. */
    sheet: (o: SheetOptions = {}) => app.playback.showSheet(o),
    endSheet: () => app.playback.endSheet(),
    /** The hero's films measured as the tests measure them, on the body the hero wears here (bench/hero.ts). */
    measure: bench,
    bones: () => app.take?.bones.map((b) => b.name) ?? [],
    edit: () => app.posing.enter(),
    /** Picks a bone and turns it about its own axis (degrees), as the gizmo would. */
    turn: (bone: string, axis: 'x' | 'y' | 'z', deg: number) => {
      const b = app.take?.bones.find((x) => x.name === bone);
      if (!b) throw new Error(`no bone ${bone}`);
      if (!app.editor.active) app.posing.enter(b);
      else app.editor.select(b);
      app.editor.nudge(axis, deg);
    },
    keepCorrection: (text: string) => keepCorrection(app, text),
    note: (kind: NoteKind, text: string, range?: [number, number]) => addNote(app, kind, text, range),
    notes: (): Note[] => store.notes,
    prompt: async (scope: Scope = 'all') => (await promptText(app, scope)).text,
    check: (note: Note) => checkNote(app, note),
    flush: () => store.flush(),
  };
}

/** Keeps the pose being corrected as a note with these words; returns its id. */
async function keepCorrection(app: App, text: string): Promise<string | null> {
  await app.posing.save();
  if (!app.notes.composer?.fix) return null;
  app.notes.composer.text = text;
  await app.notes.submit();
  return store.notes[store.notes.length - 1]?.id ?? null;
}

/** A note on the whole animation, a stretch (picked first) or the frame, with these words; returns its id. */
async function addNote(app: App, kind: NoteKind, text: string, range?: [number, number]): Promise<string | null> {
  if (range) app.playback.setRange(range);
  app.notes.compose(kind);
  if (!app.notes.composer) return null;
  app.notes.composer.text = text;
  await app.notes.submit();
  return store.notes[store.notes.length - 1]?.id ?? null;
}

/**
 * A correction against the code as it is now: opens its frame from where it was made, measures how
 * far the pose is from it, and draws the frame with the correction's ghost over it.
 */
async function checkNote(app: App, n: Note): Promise<{ measure: Measure | null; image: string; frames: number }> {
  await app.open(n.subject, n.anim, n.options, n.frame ?? n.range?.[0] ?? 0);
  const take = app.take!;
  while (!take.bake(240)) {
    /* bake */
  }
  app.playback.pause();
  app.frame = Math.min(take.frames - 1, n.frame ?? 0);
  const rig = take.ghost();
  const m = measure(take, rig, n);
  rig.dispose();
  if (n.fix?.camera) app.stage.setCamera(n.fix.camera);
  // The note's own ghost, whatever is in the store.
  const kept = app.prefs.ghosts;
  app.prefs.ghosts = false;
  app.playback.present();
  app.ghosts.begin();
  if (n.fix) app.ghosts.next(GHOST.target.color, GHOST.target.opacity)?.apply(n.fix.after);
  app.ghosts.end();
  const overlay = app.stage.overlay.visible;
  app.stage.overlay.visible = false;
  take.setDecor?.(false);
  const image = app.stage.snapshot().toDataURL('image/png');
  app.stage.overlay.visible = overlay;
  app.prefs.ghosts = kept;
  app.redraw();
  return { measure: m, image, frames: take.frames };
}
