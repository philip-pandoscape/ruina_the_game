// Accounts and characters on the game server (crates/server/src/accounts.rs, crates/server/src/characters.rs).
// Plain same-origin requests: in development Vite forwards /api to the server (vite.config.ts), and
// in production the server serves the game itself. The session cookie is http-only, so this file
// never sees it; the browser sends it.

export interface Account {
  id: number;
  username: string;
  /** Reaches the developer pages and commands (the server's ADMIN_USERS; everyone in development). */
  admin: boolean;
}

/** One of an account's characters, as the character select screen shows it. */
export interface CharacterInfo {
  id: number;
  name: string;
  /** The copy of Emberholm they live in; null until they first go in. */
  channel: number | null;
  /** When they last went into the world (ms since the epoch), or null. */
  lastPlayed: number | null;
  created: number;
  /** What their skill tree may hold: the starting points and those their quests gave. */
  skillPoints: number;
  questsDone: number;
  coins: number;
  /** The weapon in their build: 0 sword, 1 club, 2 staff, 3 bow. */
  weapon: number;
}

/** The server couldn't be reached or broke: worth trying again, unlike a refusal. */
export class ServerDown extends Error {}

/** The server said no (wrong password, a taken name...), with a sentence to show the player. */
export class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const UNREACHABLE = "Can't reach the game server.";

async function request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ServerDown(UNREACHABLE);
  }
  let data: { error?: string } | null | undefined;
  try {
    data = JSON.parse(await res.text());
  } catch {
    data = undefined;
  }
  // With the server down, Vite (or a proxy) answers instead, without the server's JSON.
  if (data === undefined) throw new ServerDown(UNREACHABLE);
  if (res.ok) return data;
  if (res.status >= 500 || !data?.error) throw new ServerDown(data?.error ?? UNREACHABLE);
  throw new Refused(data.error, res.status);
}

/** Who this browser is signed in as, or null for nobody. */
export async function currentAccount(): Promise<Account | null> {
  try {
    return (await request('GET', '/api/me')) as Account | null;
  } catch (e) {
    // A server from before /api/me answered null said 401 instead.
    if (e instanceof Refused && e.status === 401) return null;
    throw e;
  }
}

export const signIn = (username: string, password: string) => request('POST', '/api/login', { username, password }) as Promise<Account>;

/** Makes the account and its first character, named after it. */
export const register = (username: string, password: string) => request('POST', '/api/register', { username, password }) as Promise<Account>;

/** Development servers only (DEV_LOGIN=1): sign in by name alone, making the account if it's new. */
export const devSignIn = (username: string) => request('POST', '/api/dev-login', { username }) as Promise<Account>;

export async function signOut(): Promise<void> {
  await request('POST', '/api/logout', {}).catch(() => undefined);
}

/** Your characters, oldest first, and how many an account may hold. */
export const listCharacters = () => request('GET', '/api/characters') as Promise<{ characters: CharacterInfo[]; max: number }>;

/** A new character with a fresh island. Refused if the name is taken or the account is full. */
export async function createCharacter(name: string): Promise<CharacterInfo> {
  return ((await request('POST', '/api/characters', { name })) as { character: CharacterInfo }).character;
}

/** Deletes one of your characters and their island for good; `name` is their name, typed to confirm. */
export async function deleteCharacter(id: number, name: string): Promise<void> {
  await request('DELETE', `/api/characters/${id}`, { name });
}
