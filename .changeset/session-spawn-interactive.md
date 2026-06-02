---
"@emploke/api": minor
"@emploke/session": minor
---

Move session spawn invocation into SessionService (option-3 DI seam)

The "start an interactive session" call site moves from
`WorkspaceContext.spawnSession()` (in `@emploke/api`) to
`SessionService.spawnInteractive(sid, opts)` (in `@emploke/session`).
See [issue #276](https://github.com/LangSensei/emploke/issues/276).

### Why

Today's arrangement has `@emploke/session` build the `LaunchCommand`
while `@emploke/api` invokes the spawner — the package that owns
"what does a session look like" doesn't own "start a session". This
refactor flips the answer to match the domain, while preserving the
cross-package architecture fence enforced by
`packages/e2e/test/architecture/inter-service-imports.test.ts`.

### Public-surface changes

**`@emploke/session` (new public method)** — `SessionService` now
exposes:

```ts
spawnInteractive(
  id: string,
  opts?: { readonly remote?: boolean },
): Promise<SpawnSessionResult>
```

It builds the interactive `LaunchCommand` via the existing
`buildInteractiveLaunch` and hands it to the injected `SpawnFn`.
`SessionServiceConfig` and `SessionModuleOptions` accept a new
optional `spawnFn: SpawnFn` field. Two new public types are
exported: `SpawnFn` and `SpawnSessionResult` (plus the structural
`SpawnInteractiveResult` shape).

**`@emploke/api` (breaking — instance shape)** —
`WorkspaceContext.spawnSession` is removed. Callers MUST migrate to
`ctx.sessions.spawnInteractive(sid, opts)`. The HTTP API
(`POST /api/workspaces/:wid/sessions/:sid/spawn`) is unchanged: same
URL, same request body, same response body shape and status code on
both success and failure paths (pinned by the new wire-shape
integration test at
`packages/server/test/routes/spawn-response-shape.test.ts`).

`SpawnFn` and `SpawnSessionResult` are re-exported from
`@emploke/api` (now aliased to the session-package types) with
`@deprecated` JSDoc for ONE minor cycle so external type-only
consumers do not break instantly. New code SHOULD import these
types from `@emploke/session` directly. Removal is tracked as a
follow-up.

`SpawnSessionResult.launcher` is widened from the closed
`@emploke/terminal#Launcher` union to `string`. The on-wire JSON
shape is unchanged (a string is a string); consumers that need the
narrow union can import `Launcher` from `@emploke/terminal`
directly.

### Migration

```ts
// Before
const result = await ctx.spawnSession(sid, { remote: true });

// After
const result = await ctx.sessions.spawnInteractive(sid, { remote: true });
```

The return shape is identical (`SpawnSessionResult`); only the
method call site changes.

### Architecture

`@emploke/session` does NOT value-import (or even type-import)
`@emploke/terminal`. `SpawnFn` is structurally typed
(`(cmd: LaunchCommand) => Promise<{ launcher: string }>`); the
production wiring in `composeApplication` passes `spawnTerminal` in
via DI, leveraging TypeScript's structural typing to confirm
compatibility at the `composeSessionModule` call site. Preserves
the cross-package architecture fence (PRs #262/#264/#268/#270).
