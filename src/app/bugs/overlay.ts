// The little card in the top-left corner while a bug report is being made. It is left out of the
// report's own pictures (the frames are the 3D view only; screenshots skip it).

const CSS = /* css */ `
#bug-overlay { position: fixed; top: 34px; left: 14px; z-index: 60; width: 330px; box-sizing: border-box; pointer-events: none;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  background: rgba(16, 24, 34, 0.86); border: 1px solid rgba(255,255,255,0.16); border-radius: 12px; padding: 10px 12px 9px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.35); }
#bug-overlay[hidden] { display: none; }
#bug-overlay .top { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; }
#bug-overlay .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #ff4d4d; box-shadow: 0 0 8px #ff4d4d;
  animation: bug-pulse 1.1s ease-in-out infinite; }
#bug-overlay .time { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.9; }
#bug-overlay .body { margin-top: 6px; font-size: 12.5px; line-height: 1.38; opacity: 0.95; }
#bug-overlay .said { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
#bug-overlay .said .interim { opacity: 0.6; }
#bug-overlay .quiet { opacity: 0.65; font-style: italic; }
#bug-overlay .keys { margin-top: 7px; font-size: 11px; opacity: 0.85; display: flex; gap: 10px; flex-wrap: wrap; }
#bug-overlay .key { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px;
  margin-right: 4px; border-radius: 4px; background: rgba(255,255,255,0.92); color: #1d2733; font-weight: 800; font-size: 11px; text-shadow: none; }
#bug-overlay textarea { pointer-events: auto; width: 100%; box-sizing: border-box; margin-top: 7px; min-height: 66px; resize: vertical;
  font: inherit; font-size: 13px; color: #fff; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.25);
  border-radius: 8px; padding: 7px 8px; outline: none; }
#bug-overlay textarea:focus { border-color: #ffd166; }
#bug-overlay .bar { margin-top: 8px; height: 5px; border-radius: 3px; background: rgba(0,0,0,0.45); overflow: hidden; }
#bug-overlay .bar .fill { height: 100%; width: 0; background: linear-gradient(90deg, #ffd166, #ffb627); transition: width 120ms; }
#bug-overlay.saving .dot, #bug-overlay.starting .dot { background: #ffd166; box-shadow: 0 0 8px #ffd166; }
#bug-overlay.saved { border-color: rgba(123, 237, 159, 0.55); }
#bug-overlay.saved .dot { background: #7bed9f; box-shadow: 0 0 8px #7bed9f; animation: none; }
#bug-overlay.failed { border-color: rgba(255, 123, 123, 0.7); }
#bug-overlay.failed .dot { animation: none; }
#bug-overlay.warn { border-color: rgba(255, 209, 102, 0.75); }
#bug-overlay code { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; background: rgba(255,255,255,0.12); padding: 1px 4px; border-radius: 4px; }
@keyframes bug-pulse { 50% { opacity: 0.35; } }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface Keys {
  /** What the report key is labelled on this keyboard (usually \). */
  report: string;
  pad: boolean;
}

export class BugOverlay {
  readonly root = document.createElement('div');
  private note: HTMLTextAreaElement | null = null;
  private hideTimer = 0;

  constructor() {
    if (!document.getElementById('bug-overlay-css')) {
      const s = document.createElement('style');
      s.id = 'bug-overlay-css';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.root.id = 'bug-overlay';
    this.root.hidden = true;
    document.body.appendChild(this.root);
  }

  private lastHtml = '';

  private show(cls: string, html: string): void {
    clearTimeout(this.hideTimer);
    this.root.className = cls;
    this.root.innerHTML = html;
    this.root.hidden = false;
    this.note = null;
    this.lastHtml = html;
  }

  hide(): void {
    clearTimeout(this.hideTimer);
    this.root.hidden = true;
    this.note = null;
    this.lastHtml = '';
  }

  private keyHints(k: Keys, saveLabel: string): string {
    const save = k.pad ? `<span>Click Both Sticks to ${saveLabel}</span>` : `<span><span class="key">${esc(k.report)}</span>${saveLabel}</span>`;
    return `<div class="keys">${save}<span><span class="key">⌫</span>Discard</span></div>`;
  }

  starting(k: Keys): void {
    this.show(
      'starting',
      `<div class="top"><span class="dot"></span>Bug Report: Starting…</div>` +
        `<div class="body">Allow the microphone if the browser asks (Esc frees the mouse). The last 30 seconds of play are already in.</div>` +
        this.keyHints(k, 'Save Now'),
    );
  }

  recording(o: { ms: number; said: string; interim: string; mic: string | null; keys: Keys; confirmDiscard: boolean; warning: string }): void {
    if (this.note) return;
    let body: string;
    if (o.confirmDiscard) body = `<b>Throw this report away?</b> Press <span class="key">⌫</span> again to discard it.`;
    else if (o.mic) body = `<span class="quiet">No voice: ${esc(o.mic)}. You can type a note when you finish.</span>`;
    else if (o.said || o.interim) body = `<div class="said">${esc(o.said)}${o.interim ? ` <span class="interim">${esc(o.interim)}</span>` : ''}</div>`;
    else body = `<span class="quiet">Listening… say what went wrong, and show it if you can.</span>`;
    const html =
      `<div class="top"><span class="dot"></span>Recording Bug Report<span class="time">${clock(o.ms)}</span></div>` +
      `<div class="body">${body}</div>` +
      (o.warning ? `<div class="body" style="color:#ffd166">⚠ ${esc(o.warning)}</div>` : '') +
      this.keyHints(o.keys, 'Save');
    // Only touch the DOM when something changed (this runs several times a second).
    if (html !== this.lastHtml || this.root.hidden) this.show(o.confirmDiscard || o.warning ? 'warn' : '', html);
  }

  /** Asks for a typed description (when there was no microphone). Resolves with the text, or ''. */
  askNote(why: string): Promise<string> {
    this.show(
      '',
      `<div class="top"><span class="dot"></span>What went wrong?</div>` +
        `<div class="body quiet">${esc(why)}</div><textarea placeholder="Describe the bug…"></textarea>` +
        `<div class="keys"><span><span class="key">Enter</span>Save</span><span><span class="key">Esc</span>Save Without a Note</span></div>`,
    );
    const ta = this.root.querySelector('textarea')!;
    this.note = ta;
    if (document.pointerLockElement) document.exitPointerLock?.();
    setTimeout(() => ta.focus(), 0);
    return new Promise((resolve) => {
      ta.addEventListener('keydown', (e) => {
        // Keep typing out of the game's controls.
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          resolve(ta.value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          resolve('');
        }
      });
      ta.addEventListener('keyup', (e) => e.stopPropagation());
    });
  }

  /** The textarea, so the reporter can tell typing apart from its own key. */
  get noteField(): HTMLTextAreaElement | null {
    return this.note;
  }

  saving(done: number, total: number): void {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const html = `<div class="top"><span class="dot"></span>Saving Bug Report…<span class="time">${pct}%</span></div><div class="bar"><div class="fill" style="width:${pct}%"></div></div>`;
    if (this.root.className !== 'saving') this.show('saving', html);
    else this.root.querySelector<HTMLElement>('.fill')?.style.setProperty('width', `${pct}%`);
    const t = this.root.querySelector('.time');
    if (t) t.textContent = `${pct}%`;
  }

  saved(path: string): void {
    this.show(
      'saved',
      `<div class="top"><span class="dot"></span>Bug Report Saved</div>` +
        `<div class="body"><code>${esc(path)}</code><br>Type <code>/fix-bugs</code> in Claude Code to have it looked at.</div>`,
    );
    this.hideTimer = window.setTimeout(() => this.hide(), 7000);
  }

  discarded(): void {
    this.show('', `<div class="top"><span class="dot" style="background:#9aa5b1;box-shadow:none;animation:none"></span>Bug Report Discarded</div>`);
    this.hideTimer = window.setTimeout(() => this.hide(), 2500);
  }

  failed(why: string, retrying: boolean): void {
    this.show(
      'failed',
      `<div class="top"><span class="dot"></span>Bug Report Not Saved Yet</div>` +
        `<div class="body">${esc(why)}${retrying ? '<br>Retrying every few seconds; keep this tab open. Is <code>npm run dev</code> running?' : ''}</div>`,
    );
  }

  message(title: string, body: string): void {
    this.show('warn', `<div class="top"><span class="dot"></span>${esc(title)}</div><div class="body">${body}</div>`);
    this.hideTimer = window.setTimeout(() => this.hide(), 6000);
  }
}
