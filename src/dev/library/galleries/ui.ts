import { UI_ENTRIES } from '../../ui/entries';
import { h } from '../dom';
import type { AnimDef, Gallery, Subject } from '../types';

// Every window of the game's interface in a made-up state (src/dev/ui/entries.ts, made up on an
// offline island by src/dev/ui/states.ts), each drawn by /dev/ui.html in a frame of its own: the
// game's theme sets its colours on the whole document, and its tooltips and menus need a document to
// themselves, so the windows can't be drawn in the library's. The entries are plain data, so the
// library lists them without bringing in the interface. Library routes:
//   #/ui/<window>/<state>
// window.__library.gallery() = { ready(), error() } (tests/integration/uiGallery.spec.ts).

/** What the framed page says of itself (src/dev/ui/main.ts `window.__ui`). */
interface FramedUi {
  ready: boolean;
  error: string | null;
}

class UiGallery implements Gallery {
  readonly el: HTMLElement;
  readonly api: Record<string, unknown>;
  private readonly page: HTMLIFrameElement;

  constructor(private readonly entry: string) {
    this.page = h('iframe', { class: 'gl-ui', title: 'UI Gallery', src: `/dev/ui.html#/${entry}`, style: 'display:block;width:100%;height:100%;border:0' });
    this.el = h('div', { class: 'gallery' }, this.page);
    this.api = { ready: () => this.ready(), error: () => this.ui()?.error ?? null };
  }

  private ui(): FramedUi | undefined {
    return (this.page.contentWindow as (Window & { __ui?: FramedUi }) | null)?.__ui;
  }

  ready(): boolean {
    return this.ui()?.ready === true;
  }

  frame(): void {}

  numbers(): Array<{ heading: string; rows: Array<[string, string]> }> {
    const ui = this.ui();
    const made = !ui?.ready ? 'Not Yet' : ui.error ? `No: ${ui.error}` : 'Yes';
    return [
      {
        heading: 'The Window',
        rows: [
          ['Address', `/dev/ui.html#/${this.entry}`],
          ['Made Up', made],
        ],
      },
    ];
  }

  dispose(): void {
    this.page.src = 'about:blank';
  }
}

export const uiSubject: Subject = {
  id: 'ui',
  name: 'Interface',
  group: 'Galleries',
  blurb: 'Every window of the interface, in made-up states on an offline island',
  options: [],
  anims: (): AnimDef[] =>
    UI_ENTRIES.map((e) => ({ id: `${e.window}/${e.state}`, label: e.label, group: e.title, frames: 0, fps: 60, loop: true, note: e.about })),
  gallery: (_host, entry) => new UiGallery(entry),
  source: () => ({
    system:
      "Every window of the interface (src/ui/) drawn in a page of its own (/dev/ui.html, src/dev/ui/main.ts) over a real offline island: the zone's world and rules, the island's life and its windows, stepped as the game steps them, with a made-up world connection for the windows that play with others. Each entry's state is made up from the content on a fresh island (src/dev/ui/states.ts), picking things by what they are, never by their ids.",
    files: [
      { path: 'src/dev/ui/entries.ts', what: 'the entries: every window and the states worth seeing' },
      { path: 'src/dev/ui/states.ts', what: 'how each state is made up on the island' },
      { path: 'src/dev/ui/main.ts', what: 'the page: the island, the windows, stepping them' },
      { path: 'src/dev/ui/fakes.ts', what: 'the made-up world connection for the mini-game and party windows' },
    ],
    checks: [
      { command: 'npx vitest run tests/unit/uiGallery.test.ts', what: 'every entry is made up, and the entries are plain data' },
      { command: 'npx playwright test tests/integration/uiGallery.spec.ts', what: 'every entry draws its window, without an error, in Title Case' },
    ],
  }),
  animSource: (entry) => `the made-up state '${entry}' in src/dev/ui/states.ts`,
};
