# ADR-0001: Commit to pino as emploke's logging API

**Status**: Accepted (2026-05-13)

## Context

`packages/logger` originally exposed a 4-method `Logger` interface in front of pino:

```ts
interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
```

Two design intents drove the facade:

1. **Decouple call sites from pino's API.** The doc comment said: *"The interface intentionally has no child / withMeta / scoped variants — those would couple call sites to pino's API. Callers that want a 'tagged' logger build a small wrapper inline."*
2. **Reverse pino's argument order.** pino is `(meta, msg)`; the facade flipped to `(msg, meta)` so call sites read message-first.

In practice, two costs compounded as the codebase grew:

- **No `child(meta)` access.** Per-request scoping (issue #58 needs a `requestId`-bound child logger), per-component scoping (`scope: "sessions"`), and prompt-cache-aware scoping all became "build a wrapper inline" — i.e. pass `{ requestId, ... }` in every meta record by hand.
- **No pino features.** No `redact` for token sanitisation (issue #77 had to do it at the call site), no `serializers` for error rendering (issue #58 had to write `errorMeta(err)`), no `bindings()` for diagnostic introspection.

The cost the facade was avoiding — being able to swap pino for winston / bunyan / OpenTelemetry without touching ~25 call sites — is not realistic. emploke commits to pino transitively in `packages/logger/package.json`; pino is the de-facto standard for Node server logging; the swap is hypothetical work that will not happen. Meanwhile the facade is concrete daily friction.

## Decision

`Logger` is `pino.Logger`. emploke commits to pino at the type level.

```ts
// packages/logger/src/logger.ts
export type Logger = pino.Logger;
export type LogLevel = pino.Level;
export const silentLogger: Logger = pino({ level: "silent" });
```

All call sites now use pino's API directly:

```ts
// Before:
logger.warn("tasks: repository.list failed", { error: msg });
// After:
logger.warn({ error: msg }, "tasks: repository.list failed");
```

Per-request and per-component scoping uses pino's native `child`:

```ts
const reqLogger = baseLogger.child({ requestId });
const sessLogger = workspaceLogger.child({ scope: "sessions" });
```

A new test helper `captureLogger()` (under `@emploke/logger/testing`) replaces the previous `silentLogger`-as-stub pattern when a test needs to assert on log output.

## Consequences

**Gained:**

- `child(meta)` for per-request and per-component scoping. Issue #58's request-id propagation becomes one line in middleware (`c.set("logger", base.child({ requestId }))`).
- `redact` for credential sanitisation (future PRs can add a redact list in `buildLogger` so token values are auto-replaced at the pino layer rather than each call site remembering to omit them).
- `serializers` for structured error rendering. `errorMeta(err)` in `_shared.ts` is a stop-gap; a future PR can move the field-extraction logic into a pino `err` serializer so `logger.error({ err }, "...")` Just Works.
- `bindings()` for diagnostic introspection in tests.
- One fewer abstraction layer: the `adapt(p)` wrapper in `packages/logger/src/logger.ts` is gone (~30 lines removed).

**Paid (one-time):**

- ~40 call sites flipped argument order from `(msg, meta)` to `(meta, msg)`. Mechanical, caught at compile time only when `meta` was a primitive (most cases pino's overload accepts both, with the wrong runtime semantics — *output gets stringified as a printf arg*); needed to be done by grep, not type errors. Done in this PR.
- The 4-method `Logger` interface is no longer the "stable cross-package contract" — consumers see pino's full surface (~30 methods + properties). New code may reach for `logger.fatal` / `logger.trace` / `logger.level = "debug"` etc. that the facade hid; that's acceptable given the locked-in choice.
- Hypothetical "switch to a different log backend" now requires touching every call site, not just `packages/logger`. Accepted: that work isn't going to happen.

## Notes

- The `silentLogger` export is still a `Logger` and still drops every call (pino short-circuits at the level check — no allocation cost). All existing call sites that default to `silentLogger` keep working.
- `LogLevel` exposes pino's full ladder (`trace | debug | info | warn | error | fatal`) instead of the previous 4-element subset. Existing call sites pass `"info"` etc., which still type-checks.
- Test files under `packages/{task,session}/test` had hand-rolled `recorder()` fakes that mimicked the old facade. Those were updated in-place to match pino's `(meta, msg)` shape rather than rewritten to use `captureLogger`, because the tests need synchronous in-memory recording (captureLogger goes through a Writable stream that races tight assertion loops).
