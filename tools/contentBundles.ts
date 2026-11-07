import type { Plugin } from 'vite';
import { build, write } from './content/contentc.mjs';

// The dev server's half of the content (content/, a file per thing): when a file there changes, the
// bundles the game reads (shared/*.json) and the content's hash (shared/hash.json) are built again
// (tools/content/contentc.mjs), and the pages that import them reload with the change. A mistake in
// the content is shown on the terminal, and the bundles stay as they were until it's put right. A
// world server built before the change has the old hash: a page online reloads once, then stops and
// says so on the console, until the server is built again (npm run up).
export function contentBundles(): Plugin {
  return {
    name: 'ruina-content',
    configureServer(server) {
      const rebuild = (file: string) => {
        const f = file.replace(/\\/g, '/');
        if (!f.includes('/content/') || !f.endsWith('.json')) return;
        try {
          write(build());
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
