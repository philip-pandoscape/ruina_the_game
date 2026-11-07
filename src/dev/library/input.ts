import type { App } from './app';
import { openHelp } from './modals';
import { openPrompt } from './prompts';
import { VIEWS } from './stage';

// The pointer on the picture (hovering and clicking joints to pose them) and the keys (the
// Keyboard window, modals.ts openHelp, lists them all). Keys typed into a box, or while a window is
// open over the library, are left alone.

export function bindPointer(app: App): void {
  const canvas = app.stage.renderer.domElement;
  let down: { x: number; y: number; hot: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, hot: app.editor.hot };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (down || !app.take) return;
    const r = canvas.getBoundingClientRect();
    const b = app.skeleton.visible ? app.skeleton.pick(app.stage, e.clientX - r.left, e.clientY - r.top) : null;
    const name = b?.name ?? null;
    canvas.style.cursor = name && !app.editor.hot ? 'pointer' : '';
    if (name !== app.skeleton.hovered) {
      app.skeleton.hovered = name;
      app.skeleton.update();
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || d.hot || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const b = app.skeleton.visible ? app.skeleton.pick(app.stage, e.clientX - r.left, e.clientY - r.top) : null;
    if (b && !b.locked) {
      if (!app.editor.active) app.posing.enter(b);
      else app.editor.select(b);
    } else if (app.editor.active && !b) app.editor.select(null);
  });
}

export function bindKeys(app: App): void {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (document.querySelector('.scrim')) return;
    const k = e.key;
    const ed = app.editor;
    const play = app.playback;
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
      void openPrompt(app);
      e.preventDefault();
      return;
    }
    if (mod) return;
    let used = true;
    switch (k) {
      case ' ':
        play.toggle();
        break;
      case 'ArrowLeft':
        play.step(e.shiftKey ? -10 : -1);
        break;
      case 'ArrowRight':
        play.step(e.shiftKey ? 10 : 1);
        break;
      case 'Home':
        play.seek(app.range ? app.range[0] : 0);
        break;
      case 'End':
        play.seek(app.range ? app.range[1] : (app.take?.frames ?? 1) - 1);
        break;
      case '[':
        play.setRange([app.frame, app.range ? Math.max(app.range[1], app.frame) : app.frame]);
        break;
      case ']':
        play.setRange([app.range ? Math.min(app.range[0], app.frame) : app.frame, app.frame]);
        break;
      case 'Escape':
        if (ed.active) app.posing.discard();
        else if (app.notes.composer) {
          app.notes.composer = null;
          app.notesTab.render();
        } else play.setRange(null);
        break;
      case 'Enter':
        if (ed.active) void app.posing.save();
        else used = false;
        break;
      case ',':
      case '<':
        play.nudgeSpeed(-1);
        break;
      case '.':
      case '>':
        play.nudgeSpeed(1);
        break;
      case '?':
        openHelp();
        break;
      default:
        used = letter(app, k, e.shiftKey);
    }
    if (used) e.preventDefault();
  });
}

function letter(app: App, k: string, shift: boolean): boolean {
  const ed = app.editor;
  const view = VIEWS.find((v) => v.key === k);
  if (view) {
    app.setView(view.id);
    return true;
  }
  switch (k.toLowerCase()) {
    case 'l':
      app.togglePref('loop');
      app.bars.renderTransport();
      return true;
    case 'k':
      app.togglePref('skeleton');
      return true;
    case 'o':
      app.togglePref('onion');
      return true;
    case 'j':
      app.togglePref('trails');
      return true;
    case 'w':
      app.togglePref('swoosh');
      return true;
    case 'b':
      app.togglePref('outdoors');
      return true;
    case 'h':
      if (app.sheet.active) app.playback.endSheet();
      else app.playback.showSheet();
      return true;
    case 'f':
      if (app.take) app.stage.frame(app.take.framing, app.stage.view);
      return true;
    case 'n':
      app.notes.compose(shift ? 'anim' : app.range && !(app.frame >= 0 && app.range[0] === app.range[1]) ? 'range' : 'frame');
      return true;
    case 'p':
      if (ed.active) void app.posing.save();
      else app.posing.enter();
      return true;
    case 'r':
      if (ed.active) ed.setTool('rotate');
      return ed.active;
    case 's':
      if (ed.active) ed.setTool('scale');
      return ed.active;
    case 'g':
      if (ed.active) ed.setTool('move');
      else app.togglePref('ghosts');
      return true;
    case 'x':
    case 'y':
    case 'z':
      if (ed.active && ed.selected) ed.nudge(k.toLowerCase() as 'x' | 'y' | 'z', shift ? -5 : 5);
      return ed.active;
  }
  return false;
}
