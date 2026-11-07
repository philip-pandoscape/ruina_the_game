import type { Stage } from './stage';
import { ghostify } from './overlay';
import type { Posable, Take } from './types';

// A pool of ghost bodies for the take on screen: onion skins of the frames around this one, the
// corrected poses noted on this frame, and (while correcting) the frame as it was. Made the first
// time they're needed and kept until another take comes on.

export class Ghosts {
  private pool: Array<{ body: Posable; colour: string }> = [];
  private used = 0;
  private take: Take | null = null;

  constructor(private readonly stage: Stage) {}

  reset(take: Take | null): void {
    for (const g of this.pool) g.body.dispose();
    this.pool = [];
    this.used = 0;
    this.take = take;
  }

  begin(): void {
    this.used = 0;
  }

  /** The next ghost, in this colour. */
  next(color: number, opacity: number): Posable | null {
    if (!this.take) return null;
    let g = this.pool[this.used];
    if (!g) {
      const body = this.take.ghost();
      this.stage.ghosts.add(body.root);
      g = { body, colour: '' };
      this.pool.push(g);
    }
    const key = `${color}:${opacity}`;
    if (g.colour !== key) {
      ghostify(g.body, color, opacity);
      g.colour = key;
    }
    g.body.root.visible = true;
    this.used++;
    return g.body;
  }

  /** Hides whatever wasn't asked for this frame. */
  end(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].body.root.visible = false;
  }
}
