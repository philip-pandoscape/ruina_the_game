import { appendFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';

// The dev server's half of the shadow in the page (src/engine/shadow.ts, .plans/refactor R8.5). Started
// with SHADOW=1, every page it serves runs the engine's session beside the TypeScript rules
// (import.meta.env.VITE_SHADOW), and each page's first difference comes here:
//
//   POST /__shadow    the page's address, then the difference (text)
//
// It is kept in scratch/shadow-page.txt, so a whole run of the integration tier played this way can
// be read afterwards. Only pages on this machine can write.

const FILE = 'scratch/shadow-page.txt';

function local(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.');
}

export function shadowReports(): Plugin {
  const on = process.env.SHADOW === '1';
  return {
    name: 'ruina-shadow-reports',
    config: () => ({ define: { 'import.meta.env.VITE_SHADOW': JSON.stringify(on ? '1' : '') } }),
    configureServer(server) {
      if (!on) return;
      server.middlewares.use('/__shadow', async (req, res) => {
        if (req.method !== 'POST' || !local(req)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        let text = '';
        for await (const c of req) {
          text += String(c);
          if (text.length > 64 * 1024) break;
        }
        mkdirSync('scratch', { recursive: true });
        appendFileSync(FILE, `${new Date().toISOString()} ${text.slice(0, 64 * 1024)}\n\n`);
        res.statusCode = 204;
        res.end();
      });
    },
  };
}
