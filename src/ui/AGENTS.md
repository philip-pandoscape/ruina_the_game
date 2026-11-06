# src/ui

The windows and the HUD, in the Parchment & Timber look (`design/ui.html`). They show what they're
handed and ask for what they do; they never change the rules' state themselves.

| Path | What |
|---|---|
| `theme/` | The CSS, the UI laid out on a 1029 px virtual screen and scaled to the window (`scale.ts`), fonts, tooltips, right-click menus (`contextMenu.ts`), the writing rule (`text.ts`), painted icons (`icons.ts`). |
| `components/` | The pieces windows are made of: window, tabs, item slot and grid, list, bars, buttons. |
| `hud.ts` | The combat HUD: key hints, hotbar, weapon, floating numbers, the target plate, the stats line. |
| `life/` | The island's HUD and its windows docked at the sides (`lifeUI.ts`, `windows/`, `hud/`), the map and road travel (`map.ts`, `travelUI.ts`). |
| `skills/` | The skill book (T) and the skill tree (N). |
| `party/`, `minigames/` | The party frame and window (O); challenges and the game window at your table (Beacons' board). |
| `splash.ts`, `signIn.ts`, `characterSelect.ts` | The title screen, signing in, choosing a character. |
| `admin/` | The Admin menu (admins only): the developer zones and pages. |
| `icons.ts` | Icons and names for weapons and abilities. |

## Rules

- **Boundaries** (`tests/unit/boundaries.test.ts`): the UI may use content, the rules' state (through the bridge, `src/engine/`), input
  and drawing (the hero preview). It never imports the network or the app: sign-in, character
  select, the party and the mini-game windows declare the calls they make and the shapes they show
  (`SignInApi`, `CharactersApi`, `PartyLink`, `TableLink`), and the app hands them the account API
  and the world connection.
- **Writing:** labels (buttons, tabs, headings, prompts, tags) in Title Case, sentences in sentence
  case (`theme/text.ts`, checked by `tests/integration/ui.spec.ts`).
- **Items** answer a click (pick), a double-click (their main action) and a right-click (a menu).
- **Icons** are painted (`tools/icons/`); content that names an emoji no icon stands for fails
  `npm run icons`.

## Tests

`tests/integration/ui.spec.ts` (the windows, the writing rule), `hotbar.spec.ts`, `skills.spec.ts`,
`party.spec.ts`, `minigames.spec.ts`, and the sign-in and characters in `online.spec.ts`.
