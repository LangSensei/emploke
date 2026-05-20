# Changelog

## Unreleased

### Added

- inversify v7 (DI container) and mediatr-ts (request/notification
  dispatcher) deps introduced as the architectural foundation for the
  upcoming DDD + CQRS refactor (see #135 for the ADR and
  `.ceo/design/architecture-v2-e2e.md` for the full target).
- `reflect-metadata` polyfill imported at each entry point
  (`@emploke/server`, `@emploke/cli`) so future `@injectable()` /
  `@inject()` decorators have the metadata API available.
- `tsconfig.base.json` now sets `experimentalDecorators: true` +
  `emitDecoratorMetadata: true`. No existing source file uses
  decorators yet; this is foundation only.
- Per-package `composeXxxModule(container)` stubs added across
  `@emploke/workspace`, `@emploke/session`, `@emploke/task`,
  `@emploke/catalog`, and `@emploke/runtime`. Bodies are intentionally
  empty in Phase 0 — populated by Phase 1+ as bindings (repositories,
  command handlers, notification handlers, …) start moving into the
  composition root.
- `@emploke/server` ships `buildServerContainer()` (root composition
  root for the server process) plus an `InversifyResolver` bridge
  that wires inversify into mediatr-ts's `Resolver` contract.
- `@emploke/cli` ships `buildCliContainer()` with the same shape; the
  CLI's container is short-lived (one container per `emploke` command
  invocation) but the binding surface mirrors the server's so the two
  composition roots stay in lock-step until a divergence is
  motivated.
- Smoke tests in both `packages/server/test/inversify-bootstrap.test.ts`
  and `packages/cli/test/inversify-bootstrap.test.ts` assert the
  container is constructable and that the mediator is reachable via
  `container.get(Mediator)`.

### Changed

- `runServer()` (in `@emploke/server`) and `run()` (in `@emploke/cli`)
  now invoke their respective `build…Container()` at startup. The
  container is built and held but no production code path resolves
  through it yet — existing managers are still constructed by hand.
  Phase 1 of #135 will start migrating individual bindings.
