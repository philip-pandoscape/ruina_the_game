import type { App } from './app';
import { subjectById } from './subjects';
import type { Options } from './types';

// The address names what is open: #/<subject>/<animation or entry>?<options>&f=<frame>&r=<from>-<to>.
// It is written as things change (replaced, not pushed: the back button leaves the library), so a
// reload after a code change comes back to the same frame, and a link pasted in opens what it names.

export class Address {
  private timer = 0;

  constructor(private readonly app: App) {}

  /** The options as the address carries them: those with no value left out. */
  liveOptions(): Options {
    return Object.fromEntries(Object.entries(this.app.options).filter(([, v]) => v !== ''));
  }

  /** Writes the address in a moment (scrubbing writes it once it settles). */
  writeSoon(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.write(), 200);
  }

  write(): void {
    const app = this.app;
    if (!app.subject || !app.anim) return;
    const q = new URLSearchParams(this.liveOptions());
    if (app.frame) q.set('f', String(app.frame));
    if (app.range) q.set('r', `${app.range[0]}-${app.range[1]}`);
    const s = q.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}#/${app.subject.id}/${app.anim.id}${s ? `?${s}` : ''}`);
  }

  /** Opens what the address says (#/subject/anim?option=value&f=frame&r=from-to), or the hero. */
  async route(): Promise<void> {
    const app = this.app;
    const m = /^#\/([^/?]+)\/([^?]+)(?:\?(.*))?$/.exec(location.hash);
    if (!m) {
      await app.open('hero', 'idle');
      app.browser.view = 'subjects';
      app.browser.render();
      return;
    }
    if (!subjectById(decodeURIComponent(m[1]))) {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      await this.route();
      return;
    }
    const q = new URLSearchParams(m[3] ?? '');
    const frame = Number(q.get('f') ?? 0) || 0;
    const r = q.get('r')?.split('-').map(Number);
    q.delete('f');
    q.delete('r');
    await app.open(decodeURIComponent(m[1]), decodeURIComponent(m[2]), Object.fromEntries(q), frame, { range: r && r.length === 2 ? [r[0], r[1]] : null });
    app.playing = false;
    app.bars.renderTransport();
  }
}
