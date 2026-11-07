import type { App } from './app';
import { toast } from './dom';
import { GHOST, defaultMarks } from './overlay';
import { SPEEDS, savePrefs } from './prefs';
import type { SheetOptions } from './sheet';

// Playing what's open: the loop that draws every frame (a gallery steps itself; a take is baked
// ahead in the background, advanced at the chosen speed and presented when anything changed), what
// a frame shows (the body, the floor under it, onion skins and correction ghosts, the skeleton, the
// paths of hands and feet), the contact sheet laid out in its place, and the transport's commands:
// play, pause, seek, step, the picked stretch and the speed.

export class Playback {
  /** The frame on screen must be drawn again (App.redraw sets it). */
  dirty = true;
  private acc = 0;
  private lastT = performance.now();
  private galleryFrames = 0;

  constructor(private readonly app: App) {}

  /** Starts the loop: a frame drawn on every animation frame of the page, from now on. */
  start(): void {
    requestAnimationFrame((t) => this.loop(t));
  }

  /** What's open has just been opened: playing starts from its frame, with nothing carried over. */
  restart(): void {
    this.acc = 0;
  }

  private loop(now: number): void {
    const app = this.app;
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    app.frameCount++;
    if (app.gallery) {
      app.gallery.frame(dt);
      // Its numbers can change as it goes (a cost measured, a model loaded): kept current twice a second.
      if (app.tab === 'numbers' && ++this.galleryFrames % 30 === 0) app.side.renderNumbers();
      return;
    }
    const take = app.take;
    if (take) {
      // Bake ahead in the background, a few milliseconds a frame (never while a pose is being corrected).
      if (take.baked < take.frames && !app.editor.active) {
        const t0 = performance.now();
        while (performance.now() - t0 < 6 && !take.bake(4)) {
          /* keep going */
        }
        app.timeline.baked = take.baked;
        this.dirty = true;
        if (take.baked >= take.frames) this.baked();
      }
      if (app.prefs.trails && !app.trails.built && take.baked >= take.frames && !app.editor.active) this.buildTrails();
      if (app.playing && !app.editor.active) {
        this.acc += dt * app.prefs.speed * take.fps;
        const steps = Math.floor(this.acc);
        if (steps > 0) {
          this.acc -= steps;
          this.advance(steps);
        }
      }
      if (this.dirty) this.present();
    }
    app.stage.render();
  }

  private advance(n: number): void {
    const app = this.app;
    const take = app.take!;
    const [lo, hi] = app.range ?? [0, take.frames - 1];
    let f = app.frame + n;
    if (f < lo) f = lo;
    if (f > hi) {
      if (app.prefs.loop) f = lo + ((f - lo) % (hi - lo + 1));
      else {
        f = hi;
        app.playing = false;
        app.bars.renderTransport();
      }
    }
    if (f !== app.frame) {
      app.frame = f;
      this.dirty = true;
    }
  }

  /** Every frame worked out: what needs them all (paths, how close corrections are) can be done. */
  private baked(): void {
    this.app.notes.remeasure();
    if (this.app.tab === 'notes') this.app.notesTab.render();
  }

  /** Shows the current frame: the body, the floor, ghosts, skeleton, timeline, readout. */
  present(): void {
    const app = this.app;
    const take = app.take!;
    take.setDecor?.(app.prefs.swoosh && !app.editor.active);
    if (!app.editor.active) take.show(app.frame);
    const ground = take.ground(app.frame);
    // A contact sheet's bodies each stand where they are laid out: the floor stays put under them.
    app.stage.setGround(app.sheet.active ? { ...ground, x: 0, z: 0 } : ground);
    this.updateGhosts();
    take.root.updateMatrixWorld(true);
    app.skeleton.visible = app.prefs.skeleton || app.editor.active;
    app.skeleton.update();
    app.trails.group.visible = app.prefs.trails;
    app.trails.setFrame(app.frame);
    app.timeline.frame = app.frame;
    app.timeline.follow();
    app.timeline.draw();
    app.bars.renderHud();
    this.dirty = false;
  }

  private updateGhosts(): void {
    const app = this.app;
    const take = app.take!;
    const ghosts = app.ghosts;
    ghosts.begin();
    if (app.prefs.onion && !app.editor.active) {
      const step = Math.max(1, Math.round(take.fps / 15));
      for (let k = app.prefs.onionCount; k >= 1; k--) {
        for (const [dir, look] of [
          [-1, GHOST.before],
          [1, GHOST.after],
        ] as const) {
          let f = app.frame + dir * k * step;
          if (take.loop) f = ((f % take.frames) + take.frames) % take.frames;
          if (f < 0 || f >= take.frames || f >= take.baked) continue;
          const g = ghosts.next(look.color, look.opacity * (1 - (k - 1) / (app.prefs.onionCount + 1)));
          g?.apply(take.snapshot(f));
        }
      }
    }
    if (app.prefs.ghosts && !app.editor.active) {
      for (const n of app.notes.here()) {
        if (!n.fix || n.frame !== app.frame) continue;
        const g = ghosts.next(
          n.status === 'done' ? GHOST.original.color : GHOST.target.color,
          n.status === 'done' ? GHOST.original.opacity : GHOST.target.opacity,
        );
        g?.apply(n.fix.after);
      }
    }
    if (app.editor.active) {
      const g = ghosts.next(GHOST.original.color, 0.2);
      g?.apply(take.snapshot(app.frame));
    }
    ghosts.end();
  }

  /** The paths of the hands, feet and what they hold, once every frame is worked out. */
  buildTrails(): void {
    const app = this.app;
    const take = app.take;
    if (!take || take.baked < take.frames || app.editor.active) return;
    const marks = defaultMarks(take.bones);
    // What a hand holds traces its own path (a blade's tip), if it is out.
    for (const p of take.points ?? []) {
      const b = take.bones.find((x) => x.name === p.bone);
      if (b?.object.visible) marks.push({ name: p.name, bone: p.bone, at: p.at, color: 0xffffff });
    }
    app.trails.build(take, marks);
    take.show(app.frame);
    this.dirty = true;
  }

  /**
   * A contact sheet of the animation: eight frames side by side (or those asked for), spread over the
   * picked stretch or the whole of it, drawn in place of the take until anything else is asked.
   */
  showSheet(o: SheetOptions = {}): number[] {
    const app = this.app;
    const take = app.take;
    if (!take || !app.subject || !app.anim || app.editor.active) return [];
    this.pause();
    const range = app.range ? { from: app.range[0], to: app.range[1] + 1 } : {};
    const frames = app.sheet.show(app.subject, app.anim.id, app.options, take.frames, take.framing, take.framing.distance > 5, app.stage.view, {
      ...range,
      ...o,
    });
    take.root.visible = false;
    app.stage.overlay.visible = false;
    app.stage.ghosts.visible = false;
    this.dirty = true;
    app.bars.renderViewBar();
    return frames;
  }

  endSheet(): void {
    const app = this.app;
    if (!app.sheet.active) return;
    app.sheet.clear();
    if (app.take) {
      app.take.root.visible = true;
      app.stage.frame(app.take.framing, app.stage.view);
    }
    app.stage.overlay.visible = true;
    app.stage.ghosts.visible = true;
    this.dirty = true;
    app.bars.renderViewBar();
  }

  play(): void {
    const app = this.app;
    if (app.editor.active) return;
    this.endSheet();
    if (app.take && !app.prefs.loop) {
      const hi = app.range ? app.range[1] : app.take.frames - 1;
      if (app.frame >= hi) app.frame = app.range ? app.range[0] : 0;
    }
    app.playing = true;
    this.acc = 0;
    app.bars.renderTransport();
  }

  pause(): void {
    this.app.playing = false;
    this.app.bars.renderTransport();
  }

  toggle(): void {
    if (this.app.playing) this.pause();
    else this.play();
  }

  seek(f: number): void {
    const app = this.app;
    const take = app.take;
    if (!take) return;
    this.endSheet();
    if (app.editor.active) {
      if (app.editor.dirty) {
        toast('Save or discard the correction first (Esc discards)', 'warn');
        return;
      }
      app.posing.leave();
    }
    const nf = Math.max(0, Math.min(take.frames - 1, Math.round(f)));
    if (nf !== app.frame) {
      app.frame = nf;
      this.dirty = true;
      app.address.writeSoon();
    }
  }

  step(n: number): void {
    const app = this.app;
    this.pause();
    const take = app.take;
    if (!take) return;
    let f = app.frame + n;
    if (take.loop || app.prefs.loop) f = ((f % take.frames) + take.frames) % take.frames;
    this.seek(f);
  }

  setRange(r: [number, number] | null): void {
    const app = this.app;
    app.range = r ? [Math.min(r[0], r[1]), Math.max(r[0], r[1])] : null;
    app.timeline.range = app.range;
    app.timeline.draw();
    app.bars.renderTransport();
    app.address.writeSoon();
  }

  /** One speed slower (-1) or faster (1). */
  nudgeSpeed(d: number): void {
    const app = this.app;
    const i = SPEEDS.indexOf(app.prefs.speed);
    app.prefs.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 4 : i) + d))];
    savePrefs(app.prefs);
    app.bars.renderTransport();
    toast(`Speed ${app.prefs.speed}×`);
  }
}
