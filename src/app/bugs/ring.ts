/**
 * Entries stamped with performance.now(), kept while they are younger than `keepMs` - or, while a
 * report is being recorded, for as long as they are newer than the moment it started covering.
 */
export class TimeRing<T> {
  private items: Array<{ t: number; v: T }> = [];
  private head = 0;
  /** Keep everything from this time on, however old it gets (set while recording). */
  pinnedFrom = Infinity;

  constructor(
    private readonly keepMs: number,
    private readonly max = 100_000,
  ) {}

  push(t: number, v: T): void {
    this.items.push({ t, v });
    const cut = Math.min(t - this.keepMs, this.pinnedFrom);
    while (this.head < this.items.length && this.items[this.head].t < cut) this.head++;
    // A hard cap, whatever is pinned, so a report left running can't eat the tab's memory.
    if (this.items.length - this.head > this.max) this.head = this.items.length - this.max;
    if (this.head > 2048 && this.head > this.items.length / 2) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  /** Entries from `t0` on, oldest first. */
  since(t0: number): Array<{ t: number; v: T }> {
    const out: Array<{ t: number; v: T }> = [];
    for (let i = this.head; i < this.items.length; i++) if (this.items[i].t >= t0) out.push(this.items[i]);
    return out;
  }

  get oldest(): number {
    return this.head < this.items.length ? this.items[this.head].t : Infinity;
  }
}
