import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { build } from './content/contentc.mjs';

// The dev server's half of the content (content/, a file per thing): when a file there changes, the
// bundles the game reads (shared/*.json) are built again (tools/content/contentc.mjs), and the pages
// that import them reload with the change. A mistake in the content is shown on the terminal, and
// the bundles stay as they were until it's put right.
export function contentBundles(): Plugin {
  return {
    name: 'ruina-content',
    configureServer(server) {
      const rebuild = (file: string) => {
        const f = file.replace(/\\/g, '/');
        if (!f.includes('/content/') || !f.endsWith('.json')) return;
        try {
          for (const [p, v] of build()) {
            const out = join('shared', p);
            const text = `${JSON.stringify(v, null, 2)}\n`;
            if (!existsSync(out) || readFileSync(out, 'utf8') !== text) writeFileSync(out, text);
          }
        } catch (e) {
          server.config.logger.error(`content: ${(e as Error).message}`);
        }
      };
      server.watcher.on('change', rebuild);
      server.watcher.on('add', rebuild);
      server.watcher.on('unlink', rebuild);
    },
  };
}
