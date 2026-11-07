import { el } from '../../components/dom';
import { withIcons } from '../../theme/icons';

// Toasts: a line about what just happened, newest at the bottom, fading after a few seconds; at
// most five at once.

export class Toasts {
  readonly el = el('div', 'lui');
  private list: Array<{ e: HTMLDivElement; age: number }> = [];

  constructor() {
    this.el.id = 'lui-toasts';
  }

  add(text: string, kind = 'info'): void {
    const e = el('div', `t ${kind}`, withIcons(text));
    this.el.appendChild(e);
    this.list.push({ e, age: 0 });
    while (this.list.length > 5) this.list.shift()!.e.remove();
  }

  /** Every frame: each toast ages `dt` seconds, fades, then goes. */
  age(dt: number): void {
    for (const t of this.list) {
      t.age += dt;
      if (t.age > 3.6) t.e.classList.add('fade');
    }
    while (this.list.length && this.list[0].age > 4.2) this.list.shift()!.e.remove();
  }

  /** Toasts sit at the bottom right above the menu buttons, and above the ride readout while it's up. */
  place(ride: HTMLElement): void {
    const bottom = ride.classList.contains('show') ? `${parseFloat(getComputedStyle(ride).bottom) + ride.offsetHeight + 8}px` : '';
    if (this.el.style.bottom !== bottom) this.el.style.bottom = bottom;
  }
}
