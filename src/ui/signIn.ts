import { register, signIn, Refused, type Account } from '../net/account';
import type { LinkStatus } from '../net/worldLink';
import { uiRoot } from './theme/scale';
import { splash } from './splash';
import './theme/front.css';

// What you see of the game server: the sign-in screen on the title screen before Emberholm loads,
// the badge in the corner while you play (who you are, whether the server is there, Characters and
// Sign Out), and the screens that stop play: the server being updated or out of reach, another
// window taking your character, your sign-in ending.
//
// The look is in src/ui/theme/front.css (and the badge's in theme.css).

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

/** A parchment card with its title on a plaque across the top. */
export function card(title: string, ...children: Array<Node | string>): HTMLDivElement {
  return el('div', { className: 'fd-card fd-in' }, el('h2', { className: 'fd-plaque', textContent: title }), ...children);
}

/** Where the front door's cards go: the title screen, or (should there be none) a plain backdrop. */
export function frontLayer(): HTMLElement {
  if (splash) return splash.layer;
  let host = document.getElementById('fd-backdrop');
  if (!host) {
    host = el('div', { id: 'fd-backdrop' });
    host.style.cssText = 'position:fixed;inset:0;z-index:50;pointer-events:auto;background:linear-gradient(180deg,#191540,#93374a 70%,#ffb259)';
    uiRoot().append(host);
  }
  return host;
}

/** The screen before Emberholm: sign in or make an account, and say what the server is doing. */
export class SignInScreen {
  private root = el('div', { className: 'fd-front' });
  /** The server isn't answering: its card stays up while it's tried again. */
  private troubled = false;

  constructor() {
    frontLayer().append(this.root);
  }

  /** Waiting on the server: the title screen says what for (and no card is up, bar a trouble one). */
  wait(text: string): void {
    if (this.troubled) return;
    this.root.replaceChildren();
    if (splash) {
      splash.say(text);
      splash.showBar(true);
    } else this.root.append(card('Ruina', el('p', { className: 'fd-sub', textContent: text })));
  }

  /** Takes down whatever card is up. */
  clear(): void {
    this.troubled = false;
    this.root.replaceChildren();
  }

  /**
   * The server couldn't be reached. Resolves when the player asks to try again, or by itself after
   * a few seconds: a server that's restarting is usually back soon, and this carries on without a
   * click (straight back into the world, if that's where this page was going).
   */
  trouble(text: string, retryIn = 5): Promise<void> {
    return new Promise((resolve) => {
      const again = el('button', { className: 'lui-btn gold fd-wide', textContent: 'Try Again', type: 'button' });
      const timer = setTimeout(() => resolve(), retryIn * 1000);
      again.onclick = () => {
        clearTimeout(timer);
        resolve();
      };
      splash?.say('');
      const c = card('The Game Server Is Not Answering', el('p', { textContent: text }), el('p', { className: 'fd-hint', textContent: 'Trying again by itself every few seconds.' }), again);
      // Still not answering: the same card, without coming in again.
      if (this.troubled) c.classList.remove('fd-in');
      this.troubled = true;
      this.root.replaceChildren(c);
      again.focus();
    });
  }

  /** Shows the form until the player signs in or makes an account. */
  ask(note = ''): Promise<Account> {
    return new Promise((resolve) => this.form('signin', note, resolve));
  }

  close(): void {
    this.troubled = false;
    this.root.remove();
  }

  private form(mode: 'signin' | 'register', note: string, done: (a: Account) => void): void {
    const making = mode === 'register';
    this.troubled = false;
    splash?.say('');
    const name = el('input', { name: 'username', autocomplete: 'username', maxLength: 20, required: true, spellcheck: false });
    const password = el('input', { name: 'password', type: 'password', autocomplete: making ? 'new-password' : 'current-password', required: true });
    const again = el('input', { name: 'confirm', type: 'password', autocomplete: 'new-password', required: true });
    const error = el('div', { className: 'fd-error', textContent: note });
    error.setAttribute('role', 'alert');
    const submit = el('button', { className: 'lui-btn gold fd-wide', type: 'submit', textContent: making ? 'Create Account' : 'Sign In' });
    const swap = el('button', { className: 'fd-link', type: 'button', textContent: making ? 'Sign In' : 'Create Account' });
    swap.onclick = () => this.form(making ? 'signin' : 'register', '', done);

    const form = el(
      'form',
      {},
      el('label', {}, 'Name', name),
      el('label', {}, 'Password', password),
      ...(making ? [el('label', {}, 'Confirm Password', again), el('div', { className: 'fd-hint', textContent: 'Names are 3 to 20 letters, digits, - or _. Passwords need 8 or more characters.' })] : []),
      error,
      submit,
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
    this.root.replaceChildren(
      card(
        making ? 'Create Account' : 'Sign In',
        el('p', { className: 'fd-sub', textContent: making ? 'Make an account to start your life on Emberholm.' : 'Welcome back to Emberholm.' }),
        form,
        el('div', { className: 'fd-swap' }, making ? 'Have an account? ' : 'New here? ', swap),
      ),
    );
    name.focus();
  }
}

/** Who you're playing as and whether the server is there, in the corner, with Characters and Sign Out. */
export class OnlineBadge {
  private root = el('div', { id: 'ruina-badge' });
  private label = el('span', { className: 'who' });

  constructor(
    private name: string,
    on: { characters: () => void; signOut: () => void },
  ) {
    const characters = el('button', { type: 'button', textContent: 'Characters', title: 'Exit to Character Select' });
    characters.onclick = on.characters;
    const out = el('button', { type: 'button', textContent: 'Sign Out', title: 'Sign out of this account' });
    out.onclick = on.signOut;
    this.root.append(el('span', { className: 'dot' }), this.label, characters, out);
    uiRoot().append(this.root);
    this.set('online');
  }

  set(status: LinkStatus): void {
    this.root.className = status === 'online' ? '' : status === 'reconnecting' || status === 'updating' ? 'reconnecting' : 'stopped';
    this.label.textContent = status === 'reconnecting' ? `${this.name} · Reconnecting` : status === 'updating' ? `${this.name} · Updating` : this.name;
    this.root.title = status === 'online' ? 'Connected to the game server; your island is saved there' : '';
  }
}

/**
 * Over the game while the server is away: being updated (it said so before it went), or the
 * connection dropped. The world is frozen meanwhile; this goes once the connection is back.
 */
export class NetOverlay {
  private root: HTMLDivElement | null = null;
  private status = el('div', { className: 'net-status' });
  private shown: 'updating' | 'reconnecting' | null = null;
  private timer = 0;
  private since = 0;
  private tries = 0;

  show(kind: 'updating' | 'reconnecting'): void {
    if (this.shown === kind) return;
    // Updating supersedes a drop it caused; the other way round, it stays "updating".
    if (this.shown === 'updating') return;
    this.root?.remove();
    this.shown = kind;
    this.since = performance.now();
    const [title, text] =
      kind === 'updating'
        ? ['Ruina Is Being Updated', "Hold tight: you'll be right back where you were."]
        : ['Connection Lost', 'Your island is safe on the server. The game picks up where you were as soon as it is back.'];
    this.status.textContent = kind === 'updating' ? 'Waiting for the New Server…' : 'Reconnecting…';
    const reload = el('button', { className: 'lui-btn small fd-quiet', type: 'button', textContent: 'Reload Now', hidden: true });
    reload.onclick = () => location.reload();
    this.root = el('div', { id: 'ruina-net', className: kind }, card(title, el('div', { className: 'net-spin' }), el('p', { textContent: text }), this.status, reload));
    this.root.setAttribute('role', 'alertdialog');
    uiRoot().append(this.root);
    clearInterval(this.timer);
    // Taking a long time: say how long, and offer a reload.
    this.timer = window.setInterval(() => {
      const s = Math.round((performance.now() - this.since) / 1000);
      if (s >= 20) reload.hidden = false;
      if (s >= 8) this.status.textContent = `${kind === 'updating' ? 'Waiting for the New Server' : 'Reconnecting'}… ${s}s`;
    }, 1000);
  }

  /** Another try at reaching the server failed. */
  tried(): void {
    this.tries++;
  }

  hide(): void {
    clearInterval(this.timer);
    this.root?.remove();
    this.root = null;
    this.shown = null;
    this.tries = 0;
  }

  get showing(): 'updating' | 'reconnecting' | null {
    return this.shown;
  }
}

/** Play has stopped: another window took this character, or the sign-in ended. */
export function showStopped(why: 'kicked' | 'signed-out'): void {
  document.getElementById('ruina-net')?.remove();
  const go = el('button', { className: 'lui-btn gold fd-wide', type: 'button', textContent: why === 'kicked' ? 'Play Here' : 'Sign In' });
  go.onclick = () => location.reload();
  const [title, text] =
    why === 'kicked'
      ? ['Playing in Another Window', 'This character is now playing somewhere else. A character plays in one window at a time; your island was saved there.']
      : ['Signed Out', 'Your sign-in has ended. Sign in again to carry on.'];
  const root = el('div', { id: 'ruina-net', className: 'stopped' }, card(title, el('p', { textContent: text }), go));
  uiRoot().append(root);
  if (document.pointerLockElement) document.exitPointerLock();
}
