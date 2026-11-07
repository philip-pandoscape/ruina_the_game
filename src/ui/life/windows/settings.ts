import { buttonHtml } from '../../components/button';
import type { View } from '../../components/window';
import { uiIcon } from '../../theme/icons';
import { setUserScale, UI_SCALE_MAX, UI_SCALE_MIN, userScale } from '../../theme/scale';
import type { LifeContext } from '../context';

// Settings: the size of the UI, online a way back to the character select screen, and the credits.

export function settingsView(ui: LifeContext): View {
  const v = Math.round(userScale() * 100);
  // Online: back to the character select screen (the server keeps your life).
  const exit = ui.app.onExitToSelect
    ? `<div class="h">Character</div><p class="note">Play someone else: your life is saved on the server as you go.</p>${buttonHtml('Exit to Character Select', 'exitToSelect')}`
    : '';
  return {
    title: 'Settings',
    portrait: uiIcon('gear'),
    w: 420,
    h: exit ? 430 : 330,
    body: `<div class="h">Interface</div><div class="set-row"><span>UI Size</span><input type="range" min="${UI_SCALE_MIN * 100}" max="${UI_SCALE_MAX * 100}" step="5" value="${v}" data-set="uiScale"><b>${v}%</b></div><p class="note">The UI keeps its size relative to the window; this makes it bigger or smaller on top of that.</p>${exit}<div class="h">Credits</div><p class="note">Type: TeX Gyre Pagella (GUST Font License) and Alegreya SC (SIL Open Font License). Ground and grain textures from ambientCG and Poly Haven, CC0.</p>`,
    foot: buttonHtml('Reset', 'resetScale', { small: true }) + buttonHtml('Done', 'close'),
    handlers: {
      resetScale: () => {
        setUserScale(1);
        ui.redraw();
      },
      exitToSelect: () => ui.app.onExitToSelect?.(),
    },
  };
}

/** The UI Size slider moving (an input event in a window): the UI takes the size at once, and the number beside it follows. */
export function onSettingsInput(e: Event): void {
  const t = e.target as HTMLInputElement;
  if (t.dataset.set === 'uiScale') {
    setUserScale(Number(t.value) / 100);
    const out = t.parentElement?.querySelector('b');
    if (out) out.textContent = `${t.value}%`;
  }
}
