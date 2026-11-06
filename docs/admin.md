# Admins

Admins reach what players can't: the developer commands, the developer zones and the developer
pages. The server decides who is one; the browser only shows what it's told.

## Who Is an Admin

| Where | Who |
|---|---|
| Railway (beta, production) | The accounts `ADMIN_USERS` names (comma-separated, any case): `philip`. `DEV_LOGIN` is ignored there. |
| A development server (`DEV_LOGIN=1`: `npm run up`, the tests' servers) | Everyone, unless `ADMIN_USERS` names someone: then only them. |
| Anywhere else | Nobody. |

To see the game as a player on your own machine, start the server with `ADMIN_USERS=<your name>`
and sign in as anyone else (`?as=someone`).

The server tells the browser in `/api/me` and at sign-in (`admin: true`) and in the world's welcome
(`dev: true`). Nothing else changes with it: an admin plays by the same rules.

## What They Get

- **The Admin menu.** A button in character select's account row, beside Sign Out; a button on the
  world's menu bar (bottom right, before Settings); a button in the corner of the yard and the
  battlefield. It lists every developer zone and page, each opening in a new tab, and in the world
  it opens Developer Tools too. `src/ui/admin/adminMenu.ts`; the list is `src/dev/pages.ts`.
- **Developer Tools** (the backquote key, or the Admin menu): gifts, island time, teleports, the
  dungeons' doors, starting the island over, recording a bug report. Online these are commands the
  server runs only for an admin (`grant`, `warp`, `teleport`, `reset`), and so are seeded and timed
  mini-game challenges.
- **The developer pages**, `/dev/` and `/design/`: the server answers anyone else "not found", as
  if they weren't there (`admin_pages`, `server/src/http.rs`). On `npm run dev`, Vite serves them to
  anyone on this machine.
- **`POST /api/dev/stop`** on a development server: the server stops as a deploy stops it
  (`tests/integration/update.spec.ts`).

## The Zones and Pages

`src/dev/pages.ts` holds one entry per zone or page: its title, where it opens, what it's for, and
what it needs beyond the game's own files:

- `dev-server`: it saves through the development server's plugins (the animation library's notes,
  bug reports). On beta it works but can't keep anything as files, and says so: the library keeps
  its notes in the browser, the bug reporter explains why it can't save.
- `battlefield`: the server's PvP battlefield, on unless the server was started with
  `--battle off`.

The yard and the battlefield are pages of the game itself today (`/?yard`, `/?server=...`); they
become developer zones inside the world, reachable from the Admin menu only, in the refactor's
Phase 10.

## Adding a Page

1. Its HTML in `dev/` (it loads its module from `src/`, as the others do).
2. An entry in `src/dev/pages.ts`: Title Case title, a sentence saying what it's for.
3. Its HTML in the build's pages (`vite.config.ts`), so it's served on beta.
4. If a test opens it, the test goes in `tests/integration/` and reaches it at `/dev/<page>.html`.
