import { attrs } from './dom';

/**
 * A button (.lui-btn, design/ui.html: Buttons) that does its data-act (with its data-arg) in the
 * window it is in. `gold` for the window's main action (one at most), `small` in rows and feet; one
 * that can't be pressed now stays in sight, `disabled`. `label` is HTML, in Title Case.
 */
export function buttonHtml(label: string, act: string, o: { arg?: string | number; small?: boolean; gold?: boolean; disabled?: boolean } = {}): string {
  return `<button class="lui-btn${o.small ? ' small' : ''}${o.gold ? ' gold' : ''}"${attrs({ 'data-act': act, 'data-arg': o.arg })}${o.disabled ? ' disabled' : ''}>${label}</button>`;
}
