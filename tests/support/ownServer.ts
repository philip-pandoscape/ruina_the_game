import { spawn, type ChildProcess } from 'node:child_process';
import { SERVER_EXE } from './testServer';

// A game server of a spec's own (the world, with a database) and a Vite forwarding to it, for the
// specs that stop and start the server (update.spec.ts) or start it set up differently from the
// shared one (admin.spec.ts: ADMIN_USERS). Ports move up by TEST_PORT_OFFSET, as every spec's do.
// It needs a database: RUINA_DATABASE_URL (or DATABASE_URL), e.g. the one `npm run up` starts,
// postgres://ruina:ruina@127.0.0.1:5433/ruina. A spec without one skips.

export const DB = process.env.RUINA_DATABASE_URL || process.env.DATABASE_URL || '';
const OFFSET = Number(process.env.TEST_PORT_OFFSET) || 0;

/** Why a spec with a server of its own can't run here, or null if it can. */
export function ownServerMissing(built: boolean): string | null {
  if (!built) return 'needs the server built: cargo build --release';
  if (!DB) return 'needs a database for its own game server: set RUINA_DATABASE_URL (npm run up starts one at postgres://ruina:ruina@127.0.0.1:5433/ruina)';
  return null;
}

/** The game server, with developer sign-in, on `port` (plus the offset). `env` adds to its environment. */
export class GameServer {
  readonly port: number;
  private proc: ChildProcess | null = null;
  private exit: Promise<void> = Promise.resolve();

  constructor(
    port: number,
    private env: Record<string, string> = {},
  ) {
    this.port = port + OFFSET;
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  async start(): Promise<void> {
    const proc = spawn(SERVER_EXE, ['--battle', 'off', '--port', String(this.port)], {
      env: { ...process.env, DATABASE_URL: DB, DEV_LOGIN: '1', PORT: '', ...this.env },
      stdio: 'ignore',
    });
    this.proc = proc;
    this.exit = new Promise((resolve) => proc.once('exit', () => resolve()));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const r = await fetch(`${this.url}/api/health`);
        if (r.ok && (await r.json()).database === true) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('the game server did not start');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Gone at once, with no word to anyone (a crash, or the machine going away). */
  kill(): void {
    this.proc?.kill('SIGKILL');
  }

  /** Resolves once the server process has ended. */
  exited(): Promise<void> {
    return this.exit;
  }
}

/**
 * A Vite of the spec's own on `port` (plus the offset), serving the game and forwarding the account
 * API and the WebSockets to `server`. `cacheDir` is the spec's own, so two never share one.
 */
export async function viteFor(server: GameServer, port: number, cacheDir: string): Promise<{ base: string; close(): Promise<void> }> {
  const { createServer } = await import('vite');
  const target = server.url;
  const dev = await createServer({
    configFile: false,
    // Quiet: it can't reach the game server while a test has it stopped, and would say so a lot.
    logLevel: 'silent',
    cacheDir,
    server: { port: port + OFFSET, strictPort: true, proxy: { '/api': target, '/ws': { target, ws: true } } },
  });
  await dev.listen();
  return { base: `http://localhost:${port + OFFSET}`, close: () => dev.close() };
}
