import type { App } from './app';
import { toast } from './dom';
import { GHOST } from './overlay';
import { compact, modelPositions } from './pose';
import type { View } from './stage';
import type { PoseFix } from './store';
import { speciesEditing } from './subjects/species';
import type { Bone, Take } from './types';

// Correcting a frame by moving its bones (the gizmo itself is editor.ts): starting on the frame on
// screen with every frame worked out first, leaving it, and keeping the corrected pose, which draws
// the frame as it is and as corrected, from your view and from the side, into one picture for the
// note and the prompt, and measures where each joint went in the body's own space.

export class Posing {
  constructor(private readonly app: App) {}

  /** Starts correcting the frame on screen, with `bone` picked if given. */
  enter(bone?: Bone): void {
    const app = this.app;
    const take = app.take;
    if (!take) return;
    app.playback.pause();
    // Every frame worked out first: nothing may step the body while it's being posed.
    while (!take.bake(120)) {
      /* bake */
    }
    app.timeline.baked = take.baked;
    take.show(app.frame);
    take.root.updateMatrixWorld(true);
    speciesEditing(take, true);
    app.editor.begin(take);
    if (bone) app.editor.select(bone);
    app.tab = 'pose';
    app.redraw();
    app.renderAll();
  }

  leave(): void {
    const app = this.app;
    if (!app.editor.active) return;
    app.editor.end();
    if (app.take) speciesEditing(app.take, false);
    app.take?.show(app.frame);
    if (app.notes.composer?.fix) app.notes.composer = null;
    app.redraw();
    app.renderAll();
  }

  /** Throws the correction away, asking first if a bone has moved. */
  discard(): void {
    if (this.app.editor.dirty && !confirm('Throw away this correction?')) return;
    this.leave();
  }

  /** Keeps the corrected pose: a picture of it, then the note's words. */
  async save(): Promise<void> {
    const app = this.app;
    const take = app.take;
    if (!take || !app.editor.active) return;
    if (!app.editor.dirty) {
      toast('Move a bone first: drag a joint, or pick one and turn it', 'warn');
      return;
    }
    const after = compact(take.capture());
    const before = compact(take.snapshot(app.frame));
    const shot = this.picture(before, after);
    const fix: PoseFix = {
      before,
      after,
      touched: [...app.editor.touched],
      model: { before: round3(shot.modelBefore), after: round3(shot.modelAfter) },
      camera: app.stage.cameraState(),
    };
    app.notes.composer = { kind: 'frame', frame: app.frame, fix, picture: shot.canvas, text: app.notes.composer?.text ?? '' };
    app.tab = 'notes';
    app.renderAll();
  }

  /**
   * Draws the frame as it is and as corrected, from the user's view and from the side: one picture
   * for the note and the prompt. Measures where the joints are in each on the way.
   */
  private picture(
    before: ReturnType<Take['snapshot']>,
    after: ReturnType<Take['snapshot']>,
  ): { canvas: HTMLCanvasElement; modelBefore: Record<string, number[]>; modelAfter: Record<string, number[]> } {
    const app = this.app;
    const take = app.take!;
    const stage = app.stage;
    const helper = app.editor.gizmo.getHelper();
    const was = { overlay: stage.overlay.visible, ghosts: stage.ghosts.visible, helper: helper.visible };
    stage.overlay.visible = false;
    helper.visible = false;
    take.setDecor?.(false);
    const second: View = stage.view === 'side' || stage.view === 'left' ? 'front' : 'side';
    // As it is.
    stage.ghosts.visible = false;
    take.apply(before);
    take.root.updateMatrixWorld(true);
    const modelBefore = modelPositions(take);
    const a1 = stage.snapshot();
    const a2 = stage.snapshotFrom(second);
    // As corrected, the old pose faint behind it.
    app.ghosts.begin();
    app.ghosts.next(GHOST.original.color, 0.22)?.apply(before);
    app.ghosts.end();
    stage.ghosts.visible = true;
    take.apply(after);
    take.root.updateMatrixWorld(true);
    const modelAfter = modelPositions(take);
    const b1 = stage.snapshot();
    const b2 = stage.snapshotFrom(second);
    stage.overlay.visible = was.overlay;
    stage.ghosts.visible = was.ghosts;
    helper.visible = was.helper;
    app.redraw();
    return {
      canvas: fourUp(
        [a1, b1, a2, b2],
        [`Frame ${app.frame}: as it is`, 'As corrected', 'From the side: as it is', 'As corrected'],
        second === 'front' ? 'Front' : 'Side',
      ),
      modelBefore,
      modelAfter,
    };
  }
}

function round3(r: Record<string, number[]>): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const [k, v] of Object.entries(r)) out[k] = [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000];
  return out;
}

/** Four pictures in a two by two grid, each labelled, scaled to a sensible size. */
function fourUp(shots: HTMLCanvasElement[], labels: string[], secondView: string): HTMLCanvasElement {
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
