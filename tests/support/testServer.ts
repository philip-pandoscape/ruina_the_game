import { existsSync } from 'node:fs';

// Where the built game server is, for the specs that start one of their own (tests/support/
// ownServer.ts). Build it first:  cargo build --release

export const SERVER_EXE = `target/release/ruina-server${process.platform === 'win32' ? '.exe' : ''}`;
export const serverBuilt = existsSync(SERVER_EXE);
