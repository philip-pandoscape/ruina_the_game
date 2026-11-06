import { CLIMATES } from '../../../content/farming';
import { hourOfDay, raining } from '../../../engine/island';
import { angleDiff } from '../../../engine/rules';
import { el } from '../../components/dom';
import { withIcons } from '../../theme/icons';
import type { IslandUI } from '../context';

// Under the minimap: the hour (the sun, a sunrise or the moon beside it), the weather, and the
// wind, how strong and which way it blows against the way you look.

export class ClockHud {
  readonly el = el('div', '', '<span></span>');
  private key = '';

  constructor(private ui: IslandUI) {
    this.el.id = 'hud-clock';
  }

  update(): void {
    const life = this.ui.life;
    const climate = CLIMATES[life.zone.recipe.climate];
    const wind = life.state.weather;
    const rel = angleDiff(this.ui.yaw(), wind.windDir);
    const weather = raining(life) ? '🌧️' : (climate?.icon ?? '');
    const text = `${clock(this.ui.app.skyHour?.() ?? hourOfDay(life), life.zone.recipe.sky)} ${weather}`;
    const key = `${text}|${Math.round(wind.windSpeed * 100)}|${Math.round((rel * 180) / Math.PI / 10)}`;
    if (key === this.key) return;
    this.key = key;
    this.el.firstElementChild!.innerHTML =
      `${withIcons(text, 14)} · Wind <b style="transform:rotate(${(-rel * 180) / Math.PI}deg)">⬆</b> ${Math.round(wind.windSpeed * 100)}%`;
  }
}

/** "☀️ 14:20" or "🌙 23:05" for an hour of the day. */
function clock(h: number, sky: { sunrise: number; sunset: number }): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const icon = h >= sky.sunrise && h < sky.sunset ? (h < sky.sunrise + 1.5 || h > sky.sunset - 1.5 ? '🌅' : '☀️') : '🌙';
  return `${icon} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
