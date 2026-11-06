import './library.css';
import { libraryApi } from './api';
import { App } from './app';
import { store } from './store';
import { startEngine } from '../../engine/load';

// The buildings' colliders and the island come from the engine: loaded before anything is shown.
await startEngine();

// /dev/library.html: the content library, the one developer page for everything the game draws. See
// app.ts for what it does and AGENTS.md for where it fits. window.__library (api.ts) lets the tests
// and the review check drive it.

const app = new App(document.getElementById('app')!);
const api = libraryApi(app);

(window as unknown as { __library: typeof api }).__library = api;

await store.load();
store.watchOtherTabs();
await app.address.route();
api.ready = true;
void app.browser.makeThumbs();
