import { createCharacter, deleteCharacter, listCharacters, signOut, type Account, type CharacterInfo } from '../net/account';
import { HeroPreview } from '../render/heroPreview';
import { WEAPON_ICONS, WEAPON_NAMES } from './icons';
import { iconHtml, money } from './theme/icons';
import { card, el, frontLayer } from './signIn';
import { splash } from './splash';

// The character select screen, on the title screen: your characters down the right (each with its
// own island), the chosen one big in the middle, turning slowly on a glowing circle, and Enter
// World. Create Character and Delete Character (typing the name to be sure) open dialogs over it;
// Sign Out goes back to signing in. The last character chosen is remembered in this browser.
//
// Keys: Up and Down choose, Enter goes in. Double-clicking a character goes in too.

export type Choice = { enter: CharacterInfo } | { signedOut: true };

const lastKey = (account: number) => `ruina.lastCharacter.${account}`;

/** "2 hours ago" and the like. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d < 2) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Which character to show first: the one last chosen here, else the one played last, else the first. */
export function firstChoice(list: CharacterInfo[], remembered: number | null): CharacterInfo | null {
  return list.find((c) => c.id === remembered) ?? [...list].sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))[0] ?? null;
}

export class CharacterSelect {
  private root = el('div', { className: 'cs' });
  private stage = el('div', { className: 'cs-stage' });
  private list = el('div', { className: 'cs-list' });
  private count = el('small');
  private enterBtn = el('button', { className: 'lui-btn gold fd-big', type: 'button', textContent: 'Enter World' });
  private createBtn = el('button', { className: 'lui-btn fd-wide', type: 'button', textContent: 'Create Character' });
  private deleteBtn = el('button', { className: 'lui-btn fd-wide fd-quiet', type: 'button', textContent: 'Delete Character' });
  private preview: HeroPreview | null = null;
  private selected: CharacterInfo | null = null;
  private modal: HTMLElement | null = null;
  private done: ((c: Choice) => void) | null = null;
  private busy = false;

  private constructor(
    private account: Account,
    private characters: CharacterInfo[],
    private max: number,
  ) {
    const outBtn = el('button', { className: 'lui-btn small', type: 'button', textContent: 'Sign Out' });
    const panel = el(
      'div',
      { className: 'fd-card cs-panel fd-in' },
      el('h2', { className: 'fd-plaque' }, 'Characters', this.count),
      this.list,
      el('div', { className: 'cs-buttons' }, this.createBtn, this.deleteBtn),
    );
    this.root.append(
      this.stage,
      panel,
      el('div', { className: 'cs-enter' }, this.enterBtn, el('div', { className: 'tip', textContent: 'Double-click a character to enter, or press Enter.' })),
      el('div', { className: 'cs-account' }, 'Signed in as ', el('b', { textContent: account.username }), outBtn),
    );
    this.enterBtn.onclick = () => this.enter();
    this.createBtn.onclick = () => this.create();
    this.deleteBtn.onclick = () => this.remove();
    outBtn.onclick = async () => {
      if (this.busy) return;
      this.busy = true;
      await signOut();
      this.finish({ signedOut: true });
    };
    addEventListener('keydown', this.onKey);
    frontLayer().append(this.root);
    splash?.setMode('select');
    splash?.showBar(false);
    splash?.say('');
    this.render(firstChoice(characters, this.remembered()));
  }

  /** Shows the screen until the player enters the world with a character, or signs out. */
  static show(account: Account, characters: CharacterInfo[], max: number): Promise<Choice> {
    const screen = new CharacterSelect(account, characters, max);
    return new Promise((resolve) => (screen.done = resolve));
  }

  private remembered(): number | null {
    const v = Number(localStorage.getItem(lastKey(this.account.id)));
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  private render(select: CharacterInfo | null): void {
    this.count.textContent = `${this.characters.length} / ${this.max}`;
    this.list.replaceChildren();
    for (const c of this.characters) {
      const row = el('button', { className: 'cs-row', type: 'button' });
      row.dataset.id = String(c.id);
      row.setAttribute('role', 'option');
      row.innerHTML = `<span class="ib">${iconHtml(WEAPON_ICONS[c.weapon] ?? WEAPON_ICONS[0], undefined, 32)}</span>`;
      row.append(
        el(
          'span',
          {},
          el('span', { className: 'n', textContent: c.name }),
          el('span', { className: 'd', textContent: c.channel ? `Emberholm ${c.channel} · ${c.lastPlayed ? `played ${ago(c.lastPlayed)}` : 'not played yet'}` : 'New to Emberholm' }),
        ),
      );
      row.onclick = () => this.choose(c);
      row.ondblclick = () => {
        this.choose(c);
        this.enter();
      };
      this.list.append(row);
    }
    // Room for more: an empty slot makes one.
    for (let i = this.characters.length; i < this.max; i++) {
      const slot = el('button', { className: 'cs-row empty', type: 'button', textContent: 'Empty Slot' });
      slot.onclick = () => this.create();
      this.list.append(slot);
    }
    this.createBtn.disabled = this.characters.length >= this.max;
    this.choose(select ?? this.characters[0] ?? null, false);
  }

  private choose(c: CharacterInfo | null, flourish = true): void {
    const changed = c?.id !== this.selected?.id;
    this.selected = c;
    for (const row of this.list.querySelectorAll<HTMLElement>('.cs-row[data-id]')) {
      const on = Number(row.dataset.id) === c?.id;
      row.classList.toggle('sel', on);
      row.setAttribute('aria-selected', String(on));
    }
    this.enterBtn.disabled = !c;
    this.deleteBtn.disabled = !c;
    if (!c) {
      this.preview?.dispose();
      this.preview = null;
      const make = el('button', { className: 'lui-btn gold fd-big', type: 'button', textContent: 'Create Character' });
      make.onclick = () => this.create();
      this.stage.replaceChildren(
        el('div', { className: 'cs-empty fd-in' }, el('h2', { textContent: 'No Characters Yet' }), el('p', { textContent: 'Make someone to live on Emberholm: they get an island of their own.' }), make),
      );
      return;
    }
    if (!this.preview) {
      this.preview = new HeroPreview(600, 620);
      this.stage.replaceChildren(this.preview.canvas);
    }
    if (changed || !this.stage.querySelector('.cs-name')) {
      this.preview.show(c.weapon, flourish);
      const chips = el('div', { className: 'cs-chips' });
      chips.innerHTML =
        `<span>${iconHtml(WEAPON_ICONS[c.weapon] ?? WEAPON_ICONS[0], undefined, 16)}${WEAPON_NAMES[c.weapon] ?? 'Sword'}</span>` +
        `<span>${c.channel ? `Emberholm ${c.channel}` : 'New to Emberholm'}</span>` +
        `<span><b>${c.skillPoints}</b> Skill Points</span>` +
        `<span><b>${c.questsDone}</b> ${c.questsDone === 1 ? 'Quest' : 'Quests'} Done</span>` +
        `<span>${money(c.coins, 14)}</span>`;
      this.stage.querySelector('.cs-name')?.remove();
      this.stage.querySelector('.cs-chips')?.remove();
      this.stage.append(el('div', { className: 'cs-name', textContent: c.name }), chips);
    }
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.modal || this.busy) {
      if (e.key === 'Escape') this.closeModal();
      return;
    }
    const i = this.characters.findIndex((c) => c.id === this.selected?.id);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = this.characters.length;
      if (n) this.choose(this.characters[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n] ?? this.characters[0]);
    } else if (e.key === 'Enter') {
      // On another button (Create Character, say), Enter presses that button instead.
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLButtonElement && !t.classList.contains('cs-row')) return;
      e.preventDefault();
      this.enter();
    }
  };

  private enter(): void {
    const c = this.selected;
    if (!c || this.busy || this.modal) return;
    this.busy = true;
    localStorage.setItem(lastKey(this.account.id), String(c.id));
    this.finish({ enter: c });
  }

  private finish(choice: Choice): void {
    removeEventListener('keydown', this.onKey);
    this.preview?.dispose();
    this.preview = null;
    this.root.remove();
    this.done?.(choice);
  }

  private async refresh(select: number | null): Promise<void> {
    const { characters, max } = await listCharacters();
    this.characters = characters;
    this.max = max;
    this.render(characters.find((c) => c.id === select) ?? firstChoice(characters, this.remembered()));
  }

  private openModal(content: HTMLElement): void {
    this.closeModal();
    this.modal = el('div', { className: 'fd-modal' }, content);
    this.modal.addEventListener('mousedown', (e) => {
      if (e.target === this.modal) this.closeModal();
    });
    this.root.append(this.modal);
  }

  private closeModal(): void {
    this.modal?.remove();
    this.modal = null;
  }

  /** A dialog with a name field: Create Character, or Delete Character's confirmation. */
  private ask(o: { title: string; text: HTMLElement; label: string; action: string; danger?: boolean; ready?: (v: string) => boolean; go: (v: string) => Promise<void> }): void {
    const input = el('input', { name: 'name', maxLength: 20, spellcheck: false, autocomplete: 'off' });
    const error = el('div', { className: 'fd-error' });
    error.setAttribute('role', 'alert');
    const go = el('button', { className: `lui-btn ${o.danger ? '' : 'gold'}`, type: 'submit', textContent: o.action });
    const cancel = el('button', { className: 'lui-btn fd-quiet', type: 'button', textContent: 'Cancel' });
    cancel.onclick = () => this.closeModal();
    const update = () => (go.disabled = o.ready ? !o.ready(input.value.trim()) : !input.value.trim());
    input.oninput = update;
    update();
    const form = el('form', {}, o.text, el('label', {}, o.label, input), error, el('div', { className: 'fd-actions' }, cancel, go));
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      go.disabled = true;
      error.textContent = '';
      try {
        await o.go(input.value.trim());
        this.closeModal();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        update();
      }
    };
    const c = card(o.title, form);
    if (o.danger) c.classList.add('danger');
    this.openModal(c);
    input.focus();
  }

  private create(): void {
    if (this.characters.length >= this.max) return;
    this.ask({
      title: 'Create Character',
      text: el('p', { textContent: 'They start out on Emberholm with an island of their own. Their name shows over their head: 3 to 20 letters, digits, - or _.' }),
      label: 'Name',
      action: 'Create',
      go: async (name) => {
        const made = await createCharacter(name);
        await this.refresh(made.id);
      },
    });
  }

  private remove(): void {
    const c = this.selected;
    if (!c) return;
    const text = el('p', {}, 'This deletes ', el('b', { textContent: c.name }), ' and everything on their island, for good. Type their name to be sure.');
    this.ask({
      title: 'Delete Character',
      text,
      label: 'Name',
      action: 'Delete Forever',
      danger: true,
      ready: (v) => v.toLowerCase() === c.name.toLowerCase(),
      go: async (typed) => {
        await deleteCharacter(c.id, typed);
        const i = this.characters.findIndex((x) => x.id === c.id);
        await this.refresh(this.characters[i + 1]?.id ?? this.characters[i - 1]?.id ?? null);
      },
    });
  }
}
