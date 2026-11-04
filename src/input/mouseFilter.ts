// Chrome on Windows now and then reports one wildly wrong mouse movement while the pointer is
// locked: it keeps moving the hidden cursor back to the middle of the window and sometimes measures
// from the wrong place. Turned into camera movement, one such reading whips the view round by up
// to half a turn in a single frame.
//
// A hand speeds up over a few readings; a bad reading comes out of nowhere, and the one after it
// doesn't carry on the same way. So a reading far bigger than the movement just before it is held
// back for one reading: kept if the next one follows on, thrown away if not. The first reading
// after the pointer is captured is thrown away too, since it can carry the jump to the middle.

const SUSPECT = 400; // px in one reading before it can be doubted (about 57° of camera turn)
const JUMP = 6; // this many times bigger than the movement before it is "out of nowhere"
const WINDOW = 100; // ms: readings further apart than this aren't one movement

export type MouseDrop = 'spike' | 'lock';

interface Held {
  dx: number;
  dy: number;
  size: number;
  at: number;
}

export class MouseFilter {
  /** Each reading thrown away, for the bug reporter. */
  onDrop: ((dx: number, dy: number, why: MouseDrop) => void) | null = null;
  private dx = 0; // movement let through since the last take()
  private dy = 0;
  private last = 0; // size of the last reading let through
  private lastAt = -Infinity;
  private held: Held | null = null;
  private skipNext = true;

  /** One movement reading; `at` is its timestamp in ms (event.timeStamp). */
  move(dx: number, dy: number, at: number): void {
    if (this.skipNext) {
      this.skipNext = false;
      if (dx !== 0 || dy !== 0) this.onDrop?.(dx, dy, 'lock');
      return;
    }
    const size = Math.hypot(dx, dy);
    const h = this.held;
    if (h) {
      this.held = null;
      const followsOn = at - h.at <= WINDOW && size * JUMP >= h.size && dx * h.dx + dy * h.dy > 0;
      if (followsOn) this.pass(h.dx, h.dy, h.size, h.at);
      else this.onDrop?.(h.dx, h.dy, 'spike');
    }
    const before = at - this.lastAt <= WINDOW ? this.last : 0;
    if (size > SUSPECT && size > before * JUMP) this.held = { dx, dy, size, at };
    else this.pass(dx, dy, size, at);
  }

  /** The movement let through since the last call. A held reading nothing followed is dropped. */
  take(now: number): { dx: number; dy: number } {
    if (this.held && now - this.held.at > WINDOW) {
      this.onDrop?.(this.held.dx, this.held.dy, 'spike');
      this.held = null;
    }
    const out = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  /** The pointer was captured or let go: start over, and skip the next reading. */
  reset(): void {
    this.held = null;
    this.last = 0;
    this.lastAt = -Infinity;
    this.skipNext = true;
  }

  private pass(dx: number, dy: number, size: number, at: number): void {
    this.dx += dx;
    this.dy += dy;
    this.last = size;
    this.lastAt = at;
  }
}
