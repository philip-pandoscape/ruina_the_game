import { LABOR } from '../../../content/trade';
import { barHtml, setBar } from '../../components/bars';
import { el } from '../../components/dom';
import { money, uiIcon } from '../../theme/icons';
import type { IslandUI } from '../context';

// Top left: your portrait with your name on its ribbon, and beside it your health, MP, stamina and
// labor, with the purse under them.

export class PortraitHud {
  readonly portrait = el('div', '', '<div class="frame"></div><div class="ribbon"></div>');
  readonly vitals = el('div');
  private url = '';
  private purse = '';
  /** What each bar last showed, so only changes touch the page. */
  private shown = new Map<string, string>();

  constructor(private ui: IslandUI) {
    this.portrait.id = 'hud-portrait';
    this.vitals.id = 'hud-vitals';
  }

  /** Every frame (`frame` counts them): the bars; now and then the portrait. */
  update(frame: number): void {
    this.updateVitals();
    this.updatePortrait(frame);
  }

  private updatePortrait(frame: number): void {
    if (frame % 30 !== 1) return;
    const app = this.ui.app;
    const url = app.portraitOf('player');
    const box = this.portrait.querySelector('.frame')!;
    if (url && url !== this.url) {
      this.url = url;
      box.innerHTML = `<img src="${url}" alt="">`;
    } else if (!url && !box.firstChild) box.innerHTML = '<div style="display:grid;place-items:center;height:100%;font-size:44px">🧑</div>';
    const ribbon = this.portrait.querySelector('.ribbon')!;
    if (ribbon.textContent !== app.playerName) ribbon.textContent = app.playerName;
  }

  /** Health, MP, stamina and labor beside your portrait, and the purse under them. */
  private updateVitals(): void {
    const life = this.ui.life;
    const s = life.state;
    const v = this.ui.vitals();
    // Built once; after that only the fills, the numbers and the purse change (stamina refills
    // every frame after a dodge).
    if (!this.vitals.firstChild) {
      this.vitals.innerHTML =
        barHtml('hp', uiIcon('heart', 24), 'var(--hp)', 'Health', false) +
        barHtml('mp', uiIcon('mana', 19), 'var(--mp)', 'MP') +
        barHtml('st', uiIcon('stamina', 19), 'var(--stamina)', 'Stamina') +
        barHtml('labor', uiIcon('labor', 19), 'var(--labor)', 'Labor') +
        '<div class="hud-purse"></div>';
    }
    const set = (k: string, frac: number, text: string) => setBar(this.vitals, this.shown, k, frac, text);
    if (v) {
      set('hp', v.hp / v.maxHp, `${Math.max(0, Math.round(v.hp))} / ${v.maxHp}`);
      set('mp', v.mp / v.maxMp, `${Math.floor(v.mp)} / ${v.maxMp}`);
      set('st', v.stamina / v.maxStamina, `${Math.floor(v.stamina)} / ${v.maxStamina}`);
    }
    set('labor', s.labor / LABOR.max, `${Math.floor(s.labor)} / ${LABOR.max}${life.resting ? ' · Resting ×3' : ''}`);
    const purse = `${s.coins}|${s.seals}`;
    if (purse !== this.purse) {
      this.purse = purse;
      (this.vitals.querySelector('.hud-purse') as HTMLElement).innerHTML =
        `<span class="hud-pill" title="Money">${money(s.coins, 16)}</span><span class="hud-pill" title="Seals">${uiIcon('seal', 20)}${s.seals}</span>`;
    }
  }
}
