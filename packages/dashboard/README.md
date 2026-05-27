# @emploke/dashboard

The emploke dashboard SPA — React + Vite + react-router. The bundled
production build is served by `@emploke/server` on the same port the
dev server uses (8787), so dashboard URLs / muscle memory don't shift
between dev and prod.

## Modes

| script | use case | backend |
|---|---|---|
| `pnpm -F @emploke/dashboard dev` | normal dev | real emploke server on `:41817` |
| `pnpm -F @emploke/dashboard dev:mock` | UI iteration without backend | MSW + in-bundle fixtures on `:8788` |
| `pnpm -F @emploke/dashboard dev:mock:e2e` | dedicated Playwright loop for `emploke/designer` | MSW on `:5180` |
| `pnpm -F @emploke/dashboard build` | static `dist/` (consumed by `pnpm bundle`) | n/a |
| `pnpm -F @emploke/dashboard test` | vitest suite | n/a |

## Designer mode

`dev:mock` serves the dashboard against [Mock Service Worker](https://mswjs.io/)
handlers seeded from hand-authored fixtures in `src/mocks/fixtures/`.
Use this when iterating on layout, styling, or component behaviour
without needing a real emploke server up.

Fixture coverage today (read-only, issue #212 PR-A):

- **Tasks**: running / succeeded / failed / cancelled × 0 / 1 / N
  artifacts × html / image / markdown / text / json. Includes a
  `schedule`-origin task carrying `metadata.scheduleId` for the
  scheduled-tasks route.
- **Sessions, agents, workspaces**: 2–3 fixtures each.
- **Activity timelines**: hand-authored for the long-running task plus
  two terminal ones so the activity tab has user / assistant /
  thinking / tool_call / system / summary kinds to render.

Mutations (POST / PATCH / DELETE) return **501** — read-only by
design; phase-2 mutation support is tracked in issue #213.

To add a fixture, edit the relevant file under `src/mocks/fixtures/`,
add a handler in `src/mocks/handlers.ts` if you need a new route, and
restart `dev:mock`. See `src/mocks/README.md` for the file layout +
the prod-bundle exclusion guarantee.

### Ports

- `8787` — `dev` (matches the prod-bundled server port).
- `8788` — `dev:mock` (deliberately `dev port + 1` so the collision is
  obvious; `--strictPort` makes collisions fail loudly instead of
  silently re-binding).
- `5180` — `dev:mock:e2e`, dedicated to the future `emploke/designer`
  agent's Playwright dispatch (see PR `feat/designer-agent`).

### Regenerating the service worker

`public/mockServiceWorker.js` is committed verbatim — regenerate it
after upgrading the `msw` package:

```bash
pnpm -F @emploke/dashboard exec msw init public/ --save
```
