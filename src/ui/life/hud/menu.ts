import { el } from '../../components/dom';
import { uiIcon } from '../../theme/icons';

// The menu buttons at the bottom right: the bag, your character, the quest log, the map, your
// rides and the settings, each pressing what its key does (LifeUI.press).

/** A menu button's HTML: `press` is what it presses, `key` the key that does the same (or ''). */
const button = (press: string, icon: string, label: string, key: string): string =>
  `<div class="hud-mbtn" data-press="${press}" title="${label}${key ? ` (${key})` : ''}">${icon}${key ? `<span class="k">${key}</span>` : ''}<span class="lbl">${label}</span></div>`;

export class MenuBar {
  readonly el = el('div');

  constructor(press: (k: string) => void) {
    this.el.id = 'hud-menu';
    this.el.innerHTML =
      button('bag', uiIcon('bag', 34), 'Bag', 'I') +
      button('character', uiIcon('helm', 34), 'Character', 'P') +
      button('quests', uiIcon('scroll', 34), 'Quests', 'L') +
      button('map', uiIcon('map', 34), 'Map', 'M') +
      button('garage', uiIcon('wheel', 34), 'Rides', 'V') +
      button('settings', uiIcon('gear', 34), 'Settings', '');
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-press]') as HTMLElement | null;
      if (b) press(b.dataset.press!);
    });
  }

  /** Adds a button before Settings. */
  add(press: string, icon: string, label: string, key: string): void {
    const b = document.createElement('div');
    b.className = 'hud-mbtn';
    b.dataset.press = press;
    b.title = `${label}${key ? ` (${key})` : ''}`;
    b.innerHTML = `${icon}${key ? `<span class="k">${key}</span>` : ''}<span class="lbl">${label}</span>`;
    this.el.insertBefore(b, this.el.querySelector('[data-press="settings"]'));
  }
}
