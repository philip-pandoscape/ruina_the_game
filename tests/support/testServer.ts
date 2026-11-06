import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';

// Each test file runs its own battle server on its own port, so tests never join (or depend on) a
// server you're playing on. Build it first:  cargo build --release

export const SERVER_EXE = `target/release/ruina-server${process.platform === 'win32' ? '.exe' : ''}`;
export const serverBuilt = existsSync(SERVER_EXE);

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });

export class TestServer {
  readonly url: string;
  readonly port: number;
  private proc: ChildProcess | null = null;

  /** `port` moves up by TEST_PORT_OFFSET, so two checkouts' suites can run at once. */
  constructor(
    port: number,
    private args: string[],
  ) {
    this.port = port + (Number(process.env.TEST_PORT_OFFSET) || 0);
    this.url = `ws://localhost:${this.port}`;
  }

  async start(): Promise<void> {
    if (await portOpen(this.port)) throw new Error(`port ${this.port} is already in use`);
    this.proc = spawn(SERVER_EXE, ['--port', String(this.port), ...this.args], { stdio: 'ignore' });
    const deadline = Date.now() + 15_000;
    while (!(await portOpen(this.port))) {
      if (Date.now() > deadline) throw new Error('test server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
