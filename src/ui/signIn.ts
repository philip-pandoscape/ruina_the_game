import { register, signIn, Refused, type Account } from '../net/account';
import type { LinkStatus } from '../net/worldLink';

// What you see of the game server: the sign-in screen before Emberholm loads, the badge in the
// corner while you play (who you are, whether the server is there, Sign out), and the screen that
// stops play when another window takes your character or your sign-in ends.

const CSS = `
#ruina-online { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center;
  background: linear-gradient(180deg, #8fcbe6 0%, #bfe3f2 55%, #eadcb6 100%); }
#ruina-online.over-game { background: rgba(8, 14, 22, 0.6); }
#ruina-online .ro-card { width: min(380px, 92vw); padding: 26px 28px 22px; border-radius: 16px; box-sizing: border-box;
  background: rgba(22, 32, 44, 0.95); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.12); }
#ruina-online h1 { margin: 0; font-size: 34px; letter-spacing: 1px; }
#ruina-online h2 { margin: 0 0 8px; font-size: 21px; }
#ruina-online .ro-sub { margin: 2px 0 18px; opacity: 0.75; font-size: 14px; }
#ruina-online p { margin: 0 0 16px; line-height: 1.45; font-size: 14px; opacity: 0.9; }
#ruina-online label { display: block; margin: 0 0 12px; font-size: 13px; font-weight: 600; opacity: 0.9; }
#ruina-online input { display: block; width: 100%; box-sizing: border-box; margin-top: 5px; padding: 9px 11px; border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(255, 255, 255, 0.08); color: #fff; font: inherit; font-size: 15px;
  user-select: text; outline: none; }
#ruina-online input:focus { border-color: #ffd166; background: rgba(255, 255, 255, 0.12); }
#ruina-online .ro-error { min-height: 18px; margin: 2px 0 10px; color: #ff8a80; font-size: 13px; }
#ruina-online button { font: inherit; cursor: pointer; }
#ruina-online .ro-primary { width: 100%; padding: 10px; border-radius: 9px; border: 0; background: #ffd166; color: #1d2733;
  font-weight: 800; font-size: 15px; }
#ruina-online .ro-primary:disabled { opacity: 0.6; cursor: default; }
#ruina-online .ro-link { display: block; margin: 12px auto 0; border: 0; background: none; color: #fff; opacity: 0.8;
  font-size: 13px; text-decoration: underline; }
#ruina-online .ro-wait { display: flex; align-items: center; gap: 12px; font-size: 15px; }
#ruina-online .ro-spin { width: 18px; height: 18px; border-radius: 50%; border: 3px solid rgba(255, 255, 255, 0.25);
  border-top-color: #ffd166; animation: ro-spin 0.8s linear infinite; }
@keyframes ro-spin { to { transform: rotate(360deg); } }
#ruina-badge { position: fixed; top: 30px; left: 12px; z-index: 5; display: flex; align-items: center; gap: 7px;
  padding: 4px 6px 4px 10px; border-radius: 999px; background: rgba(20, 30, 40, 0.45); font-size: 12px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); }
#ruina-badge .dot { width: 8px; height: 8px; border-radius: 50%; background: #5cd65c; }
#ruina-badge.reconnecting .dot { background: #f0ad4e; }
#ruina-badge.stopped .dot { background: #d9534f; }
#ruina-badge button { font: inherit; font-size: 11px; color: #fff; cursor: pointer; padding: 2px 8px; border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.35); background: rgba(255, 255, 255, 0.1); }
`;

let styled = false;
function style(): void {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.appendChild(el);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

/** The screen before Emberholm: sign in or make an account, and say what the server is doing. */
export class SignInScreen {
  private root = el('div', { id: 'ruina-online' });
  private card = el('div', { className: 'ro-card' });

  constructor() {
    style();
    this.root.append(this.card);
    document.body.append(this.root);
  }

  /** Waiting on the server: a spinner and a line saying what for. */
  wait(text: string): void {
    this.card.replaceChildren(el('h1', { textContent: 'Ruina' }), el('div', { className: 'ro-sub', textContent: 'Emberholm' }), el('div', { className: 'ro-wait' }, el('div', { className: 'ro-spin' }), text));
  }

  /** The server couldn't be reached. Resolves when the player asks to try again. */
  trouble(text: string): Promise<void> {
    return new Promise((resolve) => {
      const again = el('button', { className: 'ro-primary', textContent: 'Try again', type: 'button' });
      again.onclick = () => resolve();
      this.card.replaceChildren(el('h2', { textContent: 'The game server is not answering' }), el('p', { textContent: text }), again);
      again.focus();
    });
  }

  /** Shows the form until the player signs in or makes an account. */
  ask(note = ''): Promise<Account> {
    return new Promise((resolve) => this.form('signin', note, resolve));
  }

  close(): void {
    this.root.remove();
  }

  private form(mode: 'signin' | 'register', note: string, done: (a: Account) => void): void {
    const making = mode === 'register';
    const name = el('input', { name: 'username', autocomplete: 'username', maxLength: 20, required: true, spellcheck: false });
    const password = el('input', { name: 'password', type: 'password', autocomplete: making ? 'new-password' : 'current-password', required: true });
    const again = el('input', { name: 'confirm', type: 'password', autocomplete: 'new-password', required: true });
    const error = el('div', { className: 'ro-error', textContent: note });
    const submit = el('button', { className: 'ro-primary', type: 'submit', textContent: making ? 'Create account' : 'Sign in' });
    const swap = el('button', { className: 'ro-link', type: 'button', textContent: making ? 'Have an account? Sign in' : 'New here? Create an account' });
    swap.onclick = () => this.form(making ? 'signin' : 'register', '', done);

    const form = el(
      'form',
      {},
      el('label', {}, 'Name', name),
      el('label', {}, making ? 'Password (8 or more characters)' : 'Password', password),
      ...(making ? [el('label', {}, 'Password again', again)] : []),
      error,
      submit,
      swap,
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (making && password.value !== again.value) {
        error.textContent = "The two passwords don't match.";
        return;
      }
      submit.disabled = true;
      error.textContent = '';
      try {
        done(await (making ? register : signIn)(name.value.trim(), password.value));
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        submit.disabled = false;
        if (err instanceof Refused && err.status === 401) password.select();
      }
    };
    this.card.replaceChildren(
      el('h1', { textContent: 'Ruina' }),
      el('div', { className: 'ro-sub', textContent: making ? 'Make an account to start on Emberholm.' : 'Sign in to play on Emberholm.' }),
      form,
    );
    name.focus();
  }
}

/** Who you're playing as and whether the server is there, in the corner, with Sign out. */
export class OnlineBadge {
  private root = el('div', { id: 'ruina-badge' });
  private label = el('span');

  constructor(
    private name: string,
    onSignOut: () => void,
  ) {
    style();
    const out = el('button', { type: 'button', textContent: 'Sign out', title: 'Sign out of this account' });
    out.onclick = onSignOut;
    this.root.append(el('span', { className: 'dot' }), this.label, out);
    document.body.append(this.root);
    this.set('online');
  }

  set(status: LinkStatus): void {
    this.root.className = status === 'online' ? '' : status === 'reconnecting' ? 'reconnecting' : 'stopped';
    this.label.textContent = status === 'reconnecting' ? `${this.name} · reconnecting, not saving` : this.name;
    this.root.title = status === 'online' ? 'Connected to the game server; your island is saved there' : '';
  }
}

/** Play has stopped: another window took this character, or the sign-in ended. */
export function showStopped(why: 'kicked' | 'signed-out'): void {
  style();
  const root = el('div', { id: 'ruina-online', className: 'over-game' });
  const go = el('button', { className: 'ro-primary', type: 'button', textContent: why === 'kicked' ? 'Play here' : 'Sign in' });
  go.onclick = () => location.reload();
  const [title, text] =
    why === 'kicked'
      ? ['Playing in another window', 'This character is now playing somewhere else. A character plays in one window at a time; your island was saved there.']
      : ['Signed out', 'Your sign-in has ended. Sign in again to carry on.'];
  root.append(el('div', { className: 'ro-card' }, el('h2', { textContent: title }), el('p', { textContent: text }), go));
  document.body.append(root);
  if (document.pointerLockElement) document.exitPointerLock();
}
