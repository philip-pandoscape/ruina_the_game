import { register, signIn, Refused, type Account } from '../net/account';
import type { LinkStatus } from '../net/worldLink';
import { uiRoot } from './theme/scale';

// What you see of the game server: the sign-in screen before Emberholm loads, the badge in the
// corner while you play (who you are, whether the server is there, Sign out), and the screen that
// stops play when another window takes your character or your sign-in ends.

// The look is in src/ui/theme/theme.css; these mount inside the scaled UI root.

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
    this.root.append(this.card);
    uiRoot().append(this.root);
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
    const out = el('button', { type: 'button', textContent: 'Sign out', title: 'Sign out of this account' });
    out.onclick = onSignOut;
    this.root.append(el('span', { className: 'dot' }), this.label, out);
    uiRoot().append(this.root);
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
  const root = el('div', { id: 'ruina-online', className: 'over-game' });
  const go = el('button', { className: 'ro-primary', type: 'button', textContent: why === 'kicked' ? 'Play here' : 'Sign in' });
  go.onclick = () => location.reload();
  const [title, text] =
    why === 'kicked'
      ? ['Playing in another window', 'This character is now playing somewhere else. A character plays in one window at a time; your island was saved there.']
      : ['Signed out', 'Your sign-in has ended. Sign in again to carry on.'];
  root.append(el('div', { className: 'ro-card' }, el('h2', { textContent: title }), el('p', { textContent: text }), go));
  uiRoot().append(root);
  if (document.pointerLockElement) document.exitPointerLock();
}
