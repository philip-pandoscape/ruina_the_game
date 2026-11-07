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

- **The Admin menu.** A button in character select's account row, beside Sign Out, and one on the
  world's menu bar (bottom right, before Settings). It lists the developer zones, which take you in
  (from character select, with the character chosen there), then every developer page, each opening
  in a new tab; in the world it opens Developer Tools too. `src/ui/admin/adminMenu.ts`; the zones are
  their own files, the pages `src/dev/pages.ts`.
- **Developer Tools** (the backquote key, or the Admin menu): gifts, island time, teleports, the
  dungeons' doors, starting the island over, recording a bug report. Online these are commands the
  server runs only for an admin (`grant`, `warp`, `teleport`, `reset`), and so are seeded and timed
  mini-game challenges.
- **The developer pages**, `/dev/` and `/design/`: the server answers anyone else "not found", as
  if they weren't there (`admin_pages`, `crates/server/src/http.rs`). On `npm run dev`, Vite serves them to
  anyone on this machine.
- **`POST /api/dev/stop`** on a development server: the server stops as a deploy stops it
  (`tests/integration/update.spec.ts`).

## The Zones

The developer zones are places beside the island that only admins go into, each a file in
`content/instances/` marked `developer` ([world.md](world.md) says how to add one):

- **The Yard**: the training dummy, slimes, and bots wandering about as moving targets; a copy for
  each party.
- **The Battlefield**: two sides of sixteen bots fighting across an arena, one copy for every admin,
  its bots there only while an admin is.
- **The Goblin Camp**: a war-band of goblins round their fire, to fight or to watch working together.

The server decides who goes in (`enter_zone`, `crates/server/src/sim/host.rs`): a player who
asks stays where they are.

## The Pages

`src/dev/pages.ts` holds one entry per page: its title, where it opens, what it's for, and whether it
needs the development server: `dev-server` pages save through its plugins (the content library's
notes, bug reports). On beta they work but can't keep anything as files, and say so: the library
keeps its notes in the browser, the bug reporter explains why it can't save. The players' own bible
(`/bible/`, open to everyone) is listed beside the design.

Everything the game draws is looked at in one page, the content library (`/dev/library.html`,
`src/dev/library/`): every animated thing frame by frame, library clips on the hero beside their source,
close-up rigs, and the galleries of models, buildings, crowds and the interface. Its address names what is open
(`#/<subject>/<animation or entry>?<options>&f=<frame>`), so a link goes straight to it. A new kind
of thing to look at is a subject or a gallery there, not a page of its own. The interface is the one
gallery the library frames rather than draws (`#/ui/<window>/<state>`): its windows are drawn by
`/dev/ui.html` (`src/dev/ui/`), on a real offline island, because the game's theme sets its colours on
the whole document and tooltips and menus need a document to themselves. The Admin menu doesn't list
that page; the library is the way to it.

## Adding a Page

1. Its HTML in `dev/` (it loads its module from `src/`, as the others do). The build makes
   every page in `dev/` and `design/` (`vite.config.ts`), so it's served on beta without more.
2. An entry in `src/dev/pages.ts`: Title Case title, a sentence saying what it's for.
3. If a test opens it, the test goes in `tests/integration/` and reaches it at `/dev/<page>.html`.
