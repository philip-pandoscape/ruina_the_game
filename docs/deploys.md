# Deploys

Two branches deploy, each to a Railway environment of its own: `beta` and `production`. CI
(`.github/workflows/ci-cd.yml`) checks every push and pull request to them, and deploys a push that
passes. No other branch is built by CI.

## Branches

| Branch | How it changes | What CI runs | Where it goes |
|---|---|---|---|
| `beta` (the default) | Pushed directly | The unit tier, the lints and the build (below); not the integration tier | https://ruinathegame-beta.up.railway.app |
| `production` | Pull requests from `beta` only (branch protection) | All of `beta`'s, plus the integration tier | https://ruinathegame-production.up.railway.app |

**On every push and pull request:**

- **The client.** It builds the engine's WebAssembly, then runs the unit tests (Vitest's `unit`
  project), dead code (knip), format and lint (`biome ci`), and the typecheck and build.
- **The server.** It runs `cargo fmt --check`, clippy with warnings as errors, and the Rust tests in
  debug.

**Pull requests, production and a manual run** also play the integration tier:

- the WebAssembly against the native engine (the conformance project, on the first runner);
- the Playwright suite on four runners, against a real server and database.

"Game tests" is the one check to require.

A push to `beta` skips the integration tier, which takes half an hour and more without a GPU. So:

- **Before every push to `beta`,** run `npm run check:beta` (the unit, conformance and integration
  tiers).
- **Before a release,** run `npm run check:release`, which adds the stress tier (it needs a real
  GPU, so it never runs in CI).

## Railway

The Railway project is `intuitive-enthusiasm`, with environments `beta` and `production`, each with
its own Postgres.

- **Deploying.** The deploy job uploads the checkout, with the real files rather than their LFS
  pointers (`railway up`). It goes to the service `ruina_the_game` in the environment named for the
  branch, and waits until that is live (`.github/scripts/railway-wait.mjs`).
- **Keys.** Each GitHub environment holds `RAILWAY_TOKEN`, that Railway environment's project token,
  and accepts deployments only from its own branch. Without the key, the deploy is skipped with a
  warning.
- **What Railway builds:** the `Dockerfile`'s `app` stage. It holds the engine's WebAssembly, the
  game built by Vite, and the server built in release on Debian slim, which serves the built game.
- **`railway.json`:**
  - the health check, `/api/health`, given 120 s;
  - a restart on failure, up to 10 times;
  - 20 s for a stopping server to finish.

## The Game Service's Settings

| Variable | What |
|---|---|
| `DATABASE_URL` | A reference to the environment's Postgres. The server applies the migrations (`crates/server/migrations/`) when it starts. |
| `PORT` | 8080 on Railway (the image's default is 7777). |
| `ADMIN_USERS` | The accounts, by name, that reach the developer pages and commands (`philip`; [admin.md](admin.md)). |
| `LISTEN` | `all` in the image. A server run natively listens on its own machine only (`--listen all` changes that). |
| `STATIC_DIR` | Where the built game is (`/app/dist` in the image). |
| `DEV_LOGIN` | `1` for developer sign-in (`?as=name`). Ignored on Railway, which the server knows by `RAILWAY_PROJECT_ID`. |
| `COOKIE_SECURE` | `1` for secure cookies; always on on Railway. |

## A Deploy, as Players See It

1. The stopping server tells every player `{t:"updating"}`, saves every island, then closes with
   code 1012, within the 20 s Railway gives it.
2. Pages freeze, then reconnect.
3. A page reloads straight back into the world when:
   - a new build is out;
   - the server speaks another `WORLD_PROTOCOL` (`crates/server/src/gate/socket.rs`,
     `src/net/worldLink.ts`);
   - the server's content differs from the page's (the content's hash, in the welcome).

Raise `WORLD_PROTOCOL` when the wire changes in a way an older page can't read.

To try it locally: `POST /api/dev/stop` does the same, for a signed-in admin, where `DEV_LOGIN=1`.
`tests/integration/update.spec.ts` plays it, and needs `RUINA_DATABASE_URL`.

## Several Processes

`ruina-server` plays every tier in one process (`--role all`, the default, as on Railway today). It
can also run as several processes, a role each ([architecture.md](architecture.md), Several
Processes), all on one Postgres, where they find each other.

| Variable | Flag | What |
|---|---|---|
| `ROLE` | `--role` | `all` (the default), `gate`, `sim` or `services` |
| `NODE_ID` | `--node` | The process's id in the directory, unique on its database (by default the role and a random number) |
| `LINK_LISTEN` | `--link` | Where its links listen: this machine and any free port, or `[::]:9000` with `LISTEN=all` |
| `LINK_ADVERTISE` | `--advertise` | Where the others dial it: by default where it listens, or on Railway `RAILWAY_PRIVATE_DOMAIN` and the link's port |
| `SPACES` | `--spaces` | The spaces a sim stands for: `channel:emberholm:1,copy:goblinsDread:3` |
| `LEASE_MS` | `--lease-ms` | A lease's length (10000), renewed every fifth of it; a sim stops a fifth before it runs out |

Every role needs `DATABASE_URL`, and serves `/api/health` and `/api/cluster` (the directory as it
sees it) on its `PORT`. On this machine, each in a terminal of its own, on your rig's database:

```sh
DATABASE_URL=postgres://... ./ruina-server --role services --port 9150
DATABASE_URL=postgres://... ./ruina-server --role sim --spaces channel:emberholm:1 --port 9151
DATABASE_URL=postgres://... ./ruina-server --role sim --spaces channel:emberholm:1 --port 9152   # standing by
DATABASE_URL=postgres://... ./ruina-server --role gate --port 9153
curl http://localhost:9153/api/cluster
```

`npm run test:cluster` starts processes like these, then kills them, cuts the links between them and
doubles what passes ([testing.md](testing.md)).

**On Railway** (a sketch, not set up: the beta stays one service until the gate and the sims run
apart, the multi-server work's second half):

- A service per role, from the same image, each with its `ROLE`, all on the environment's Postgres.
- `LISTEN=all`, so links listen on `[::]:9000`. The others dial a service through Railway's private
  network at `<service>.railway.internal:9000`, which a process advertises by default
  (`RAILWAY_PRIVATE_DOMAIN`).
- Only the gate has a public domain. Every role keeps the health check, `/api/health`.
- More sims are more services (`sim-1`, `sim-2`): a replica shares its service's private name, so
  replicas of one sim service would need to advertise their own addresses.

## Never

- Commit `.env` (Railway keys, `GEMINI_API_KEY`).
- Push to `production`: it changes by pull request from `beta` alone.
- Set `DEV_LOGIN`, or `ADMIN_USERS` to more than its admins, anywhere players are.
