# src/dev

The developer pages, for admins only (`docs/admin.md`): the server answers them to the accounts
`ADMIN_USERS` names, and the Admin menu (`src/ui/admin/`) lists them.

| Path | What |
|---|---|
| `pages.ts` | The pages an admin can reach that players can't (the content library, the design bible's Development tab), for the Admin menu. |
| `library/` | The content library, `/dev/library.html`: everything the game draws, each animation scrubbable frame by frame, the galleries (models, buildings cut open over the rules' walls, crowds), and notes on animations that become a prompt for Claude (`prompt.ts`; the `animation-review` skill). `app.ts` holds what is open; its parts reach each other through it (`layout.ts`, `playback.ts`, `posing.ts`, `notes.ts`, `panels/`...); `window.__library` is its test API (`api.ts`). |

## Rules

- **Boundaries:** developer pages may import any area, and no area imports them
  (`tests/unit/boundaries.test.ts`).
- **A new page** goes in `src/dev/pages.ts` so the Admin menu lists it, and is served to admins only.

## Tests

`tests/integration/library.spec.ts` and the gallery specs (`models`, `buildings`, `creatures`,
`species`, `retarget`); `library-review.spec.ts` measures a review's corrected poses (`REVIEW=`).
