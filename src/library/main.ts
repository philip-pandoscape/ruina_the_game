import './library.css';
import { App } from './app';
import { store, type Note } from './store';
import { SUBJECTS } from './subjects';

// /library.html: the animation library. See app.ts for what it does and AGENTS.md for where it fits.
// window.__library lets tests (tests/library.spec.ts) and the review check (tests/library-review.spec.ts)
// drive it.

const app = new App(document.getElementById('app')!);

const api = {
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
  }),
  seek: (f: number) => app.seek(f),
  play: () => app.play(),
  pause: () => app.pause(),
  bakeAll: () => {
    const t = app.take;
    if (t) while (!t.bake(240)) {
      /* bake */
    }
  },
  bones: () => app.take?.bones.map((b) => b.name) ?? [],
  edit: () => app.enterEdit(),
  /** Picks a bone and turns it about its own axis (degrees), as the gizmo would. */
  turn: (bone: string, axis: 'x' | 'y' | 'z', deg: number) => {
    const b = app.take?.bones.find((x) => x.name === bone);
    if (!b) throw new Error(`no bone ${bone}`);
    if (!app.editor.active) app.enterEdit(b);
    else app.editor.select(b);
    app.editor.nudge(axis, deg);
  },
  keepCorrection: (text: string) => app.keepCorrection(text),
  note: (kind: 'anim' | 'range' | 'frame', text: string, range?: [number, number]) => app.addNote(kind, text, range),
  notes: (): Note[] => store.notes,
  prompt: async (scope: 'anim' | 'subject' | 'all' = 'all') => (await app.promptText(scope)).text,
  check: (note: Note) => app.checkNote(note),
  flush: () => store.flush(),
};

(window as unknown as { __library: typeof api }).__library = api;

await store.load();
store.watchOtherTabs();
await app.route();
api.ready = true;
void app.makeThumbs();
