// The main loop: each animation frame steps the rules at 60 Hz for the time that has passed (at most
// five steps a frame), with what you pressed for each step, then draws the frame between the last
// two steps. Tests pause it and step it a frame at a time (src/app/testApi.ts).
import { NO_ACTIONS, angleDiff } from '../engine/rules';
import { RIDE_CAMERA } from '../content/traversal';
import { STEP } from '../content/tuning';
import type { GameRefs } from '../main';

export function startLoop(g: GameRefs) {
  const { aiming, drawing, follow, hud, input, life, lifeUI, online, panel, party, perfs, rideCamera, scripted, stepOnce, syncNet, walker } = g;
  let paused = g.testMode;
  let acc = 0;
  let last = performance.now();
  let lastStats = 0;
  /** Frames drawn so far (the title screen fades once the first few are up). */
  let framesDrawn = 0;

  /** Throws away whatever was pressed (while frozen): it mustn't all happen at once when play resumes. */
  function dropInput(): void {
    input.pollLife(true);
    input.pollMenu();
    input.pollCamera(0);
    input.pollCombat();
    input.pollActions(follow.yaw);
  }

  function frame(now: number): void {
    // Asked for first, so one frame that throws can't stop the game.
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    perfs.frame(dt * 1000);
    const cpuStart = performance.now();

    if (g.frozen) {
      dropInput();
    } else if (!paused) {
      // A window open on a controller has the pad: its stick and buttons drive the window, so you
      // stand still. With a keyboard and mouse you can walk with a window open (walking away from
      // whoever you're talking to closes it). The skill panel and the map take every device.
      const padToMenu = panel.isOpen || ((!!lifeUI?.takesPad || !!party?.takesPad) && input.lastDevice === 'gamepad');
      // Open-world keys first, so a panel they open takes this frame's input. The skill book and
      // tree sit over everything while they're open, so the world's keys wait.
      if (lifeUI) {
        const keys = input.pollLife(padToMenu);
        if (!panel.isOpen) {
          for (const k of keys) {
            g.bugs?.note('key', { type: k });
            lifeUI.press(k);
          }
        }
      }
      const menuOpen = padToMenu || !!lifeUI?.modal;
      for (const m of input.pollMenu()) {
        g.bugs?.note('menu', { type: m });
        if (panel.isOpen) {
          panel.menu(m);
          continue;
        }
        // A party invitation or the Party window takes the D-pad and A / B first (src/ui/party), then
        // an open life panel (dialog, shop, bag...).
        if (party?.menu(m)) continue;
        if (lifeUI?.menu(m)) continue;
        if (m === 'toggle') panel.open('book');
        else if (m === 'tree') panel.open('tree');
      }
      panel.tick();
      // Just closed (B, say): whatever closed it is still held, and mustn't count as a press in the
      // game once the menu is gone - B would slide. Reading the controls now uses those presses up,
      // even on a frame that runs no rules step to read them. A docked window that still has the
      // controller hasn't closed.
      if (menuOpen && !panel.isOpen && !lifeUI?.modal && !(lifeUI?.takesPad && input.lastDevice === 'gamepad')) input.pollActions(follow.yaw);
      const cam = input.pollCamera(dt);
      syncNet();
      const placing = !menuOpen && aiming.update(cam, dt);
      if (!menuOpen && !placing) {
        follow.rotate(cam.dYaw, cam.dPitch);
        follow.zoom(cam.dZoom);
        if (cam.dYaw !== 0 || cam.dPitch !== 0) g.lastCameraTouch = now;
      }
      if (life) rideCamera(dt, now);
      // Travelling by road on foot, the camera comes round behind you as it does on a mount, unless
      // you have been turning it yourself.
      if (
        walker?.mode === 'travel' &&
        g.sim.player.mode !== 'ride' &&
        now - g.lastCameraTouch > RIDE_CAMERA.autoDelay * 1000 &&
        Math.hypot(g.sim.player.vel.x, g.sim.player.vel.z) > 1.5
      ) {
        follow.yaw += angleDiff(follow.yaw, g.sim.player.facing) * (1 - Math.exp(-RIDE_CAMERA.autoFollow * dt));
      }
      // Online the world waits while the connection is down: inputs that can't reach the server
      // would only be taken back.
      if (online && !online.link.open) acc = 0;
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 5) {
        const pad = input.pollActions(follow.yaw);
        // With the panel open and an ability waiting to be placed, a hotbar press assigns it
        // instead of casting it.
        if (menuOpen && pad.abilitySlot >= 1 && panel.isAssigning) panel.assignToSlot(pad.abilitySlot);
        const own = scripted.length ? scripted.shift()! : menuOpen ? NO_ACTIONS : pad;
        // Auto-run or travel by road moves you, until your own moving takes over.
        const a = walker ? walker.steer(own, follow.yaw) : own;
        stepOnce(aiming.aim(a));
        acc -= STEP;
        steps++;
      }
      if (steps === 5) acc = 0; // don't spiral if the tab was in the background
      drawing.draw(acc / STEP, dt, dt);
      framesDrawn++;
    } else {
      drawing.draw(1, 0, 0);
      framesDrawn++;
    }
    perfs.cpuSpent(performance.now() - cpuStart);

    if (now - lastStats > 250) {
      lastStats = now;
      hud.setStats(perfs.line());
    }
  }
  requestAnimationFrame(frame);
  return {
    get acc() {
      return acc;
    },
    set acc(v) {
      acc = v;
    },
    get framesDrawn() {
      return framesDrawn;
    },
    set framesDrawn(v) {
      framesDrawn = v;
    },
    get last() {
      return last;
    },
    set last(v) {
      last = v;
    },
    get paused() {
      return paused;
    },
    set paused(v) {
      paused = v;
    },
  };
}
