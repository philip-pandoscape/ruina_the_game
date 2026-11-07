// Plays the world as several processes on this machine: the services, two sims and a gate, each
// ruina-server in its role (crates/server/src/cluster), finding each other through the directory in
// DATABASE_URL's Postgres. Ctrl-C stops them all.
//
//   DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5433/ruina npm run cluster
//
// The gate serves the game's API and WebSocket on CLUSTER_PORT (7790), developer sign-in on; point
// the dev server at it with RUINA_SERVER=http://localhost:7790 npm run dev. The services' and sims'
// status, /api/cluster, is on the three ports after it. Leases of LEASE_MS (10000).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const database = process.env.DATABASE_URL;
if (!database) {
  console.error('DATABASE_URL: the processes find each other through the directory in Postgres');
  process.exit(1);
}
const bin = path.join('target', 'release', process.platform === 'win32' ? 'ruina-server.exe' : 'ruina-server');
if (!existsSync(bin)) {
  console.error(`${bin} isn't built: node tools/cargo.mjs build --release --bin ruina-server`);
  process.exit(1);
}
const port = Number(process.env.CLUSTER_PORT ?? 7790);
const lease = process.env.LEASE_MS ?? '10000';
const processes = [
  { role: 'services', node: 'services-1', port: port + 1 },
  { role: 'sim', node: 'sim-1', port: port + 2 },
  { role: 'sim', node: 'sim-2', port: port + 3 },
  { role: 'gate', node: 'gate-1', port },
];

const children = processes.map((p) => {
  const env = { ...process.env, DATABASE_URL: database, DEV_LOGIN: process.env.DEV_LOGIN ?? '1' };
  for (const name of ['ROLE', 'NODE_ID', 'LINK_LISTEN', 'LINK_ADVERTISE', 'PORT']) delete env[name];
  const child = spawn(bin, ['--role', p.role, '--node', p.node, '--port', String(p.port), '--lease-ms', lease], { env });
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) console.log(`[${p.node}] ${line}`);
    });
  }
  child.on('exit', (code) => console.log(`[${p.node}] stopped (${code})`));
  return child;
});

console.log(`the world on ${processes.length} processes: the gate at http://localhost:${port}, status at /api/cluster on ${port + 1}-${port + 3}`);
const stop = () => {
  for (const c of children) c.kill();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
