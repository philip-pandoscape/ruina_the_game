// The interface's look, before anything is drawn on the title screen, in the order the game imports
// it (src/main.ts), so the sheets cascade as they always did; the skill book's comes with the game.
import '../ui/theme/theme.css';
import '../ui/theme/hud.css';
import '../ui/theme/windows.css';
import { initUiScale } from '../ui/theme/scale';
import { installLogCapture } from './bugs/logs';
import { chosen, goOnline } from './online';
import { readOptions } from './options';
import { migrateStorage } from './storage';

// The page's way in (index.html loads this). The first download is the title screen, sign-in and
// character select, and no more (docs/assets.md, held to a budget by
// tests/integration/download.spec.ts): the rest of the game (src/main.ts: the world, its rules, the
// HUD and everything else) is fetched once a character is chosen, while the world link opens, and
// the world's files stream in after it (src/assets/loader.ts). Straight in (?as=name, a reload into
// the world) a character is chosen at once; the offline modes the tests use (?test, ?test=<instance>,
// ?offline) have no way in, and fetch the game at once.

// What this browser kept under the game's old name moves to its new one, before anything reads it.
migrateStorage(localStorage);
// The UI is laid out on a virtual screen and scaled to the window, sign-in's cards too.
initUiScale(document.getElementById('ui') as HTMLElement);
// Console output and errors are kept from here on, for bug reports.
installLogCapture();
const opt = readOptions();
if (!opt.test && !opt.offline) {
  void goOnline(opt);
  await chosen;
}
await import('../main');
