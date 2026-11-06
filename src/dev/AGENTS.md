# src/dev

The developer pages, for admins only (`docs/admin.md`): the server answers them to the accounts
`ADMIN_USERS` names, and the Admin menu (`src/ui/admin/`) lists them.

| Path | What |
|---|---|
| `pages.ts` | The pages an admin can reach that players can't (the content library, the design bible's Development tab), for the Admin menu. |
| `library/` | The content library, `/dev/library.html`: everything the game draws, each animation scrubbable frame by frame, the galleries (models, buildings cut open over the rules' walls, crowds, the interface), and notes on animations that become a prompt for Claude (`prompt.ts`; the `animation-review` skill). `app.ts` holds what is open; its parts reach each other through it (`layout.ts`, `playback.ts`, `posing.ts`, `notes.ts`, `panels/`...); `window.__library` is its test API (`api.ts`). |
| `ui/` | The UI gallery, `/dev/ui.html#/<window>/<state>`, which the library frames (`galleries/ui.ts`, `#/ui/<window>/<state>`): a window of the interface in a made-up state on a real offline island (the zone's world, the rules, the island's life and the windows, stepped as the game steps them). A page of its own, as the game's theme sets its colours on the whole document and tooltips and menus need one to themselves. `entries.ts` lists the entries as plain data (the library reads it without bringing in `src/ui`); `states.ts` makes each one up from the content, picking things by what they are, never by their ids; `fakes.ts` is the world connection the mini-game and party windows read, made up, its clocks standing still. A new window or state is an entry and how it is made up; `window.__ui` is its test API. |

## Rules

- **Boundaries:** developer pages may import any area, and no area imports them
  (`tests/unit/boundaries.test.ts`).
- **A new page** goes in `src/dev/pages.ts` so the Admin menu lists it, and is served to admins only.
  A page the library frames (`dev/ui.html`) is reached through the library instead.

## Tests

`tests/integration/library.spec.ts` and the gallery specs (`models`, `buildings`, `creatures`,
`species`, `retarget`, `uiGallery`: every window made up, drawn and in Title Case, its screenshots in
`screenshots/ui-*`); `library-review.spec.ts` measures a review's corrected poses (`REVIEW=`).
`tests/unit/uiGallery.test.ts` holds the UI gallery's entries to the states made up.
