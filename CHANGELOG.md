# Changelog

All notable changes to the emploke control plane land here. Per-package
catalog entries (`first-party/agents/*`, `first-party/skills/*`) keep
their own `CHANGELOG.md` because they version independently.

## Unreleased

### Bug fixes

- **task**: name-string fallback alongside `instanceof AgentNotFoundError`
  in `task-service.dispatch` so foreign sibling classes thrown from
  `@emploke/schedule` or `@emploke/session` keep their typed boundary
  instead of getting re-wrapped (would have surfaced as 500 instead of
  400 at the route layer). [TN-D F1-2]

### Dashboard correctness

- **dashboard**: consolidate 5 incompatible reinventions of `splitFqn`
  into `src/utils/fqn.ts`. The strict variant delegates to
  `@emploke/catalog`'s canonical `splitFqn` for zero drift; the display
  variant has the never-throw fallback for render paths. Field name
  unified to `shortName` across call sites. [TN-B F1-4]
- **dashboard**: extract `useMounted()` with React 18 StrictMode-safe
  re-init in the effect body, replacing 7 reinventions that would have
  silently swallowed `setState` calls after a StrictMode remount.
  [TN-B F3-5]
- **dashboard**: add `errorMessage(e)` + `isAbortError(e)` helpers and
  retrofit ~30 `(e as Error).message` and 3 `AbortError` catch sites.
  No behavioural change. [TN-B F3-1]

### Documentation

- **catalog**: fix `packages/catalog/README.md` schema sentence —
  five fields, drop the non-existent `type` reference, correct
  `prereq` → `prereqs`. [TN-E F3-1]
- **skills**: correct attribution prose in `karpathy-guidelines` and
  `thermo-nuclear-code-quality-review` to say `scope: emploke` (the
  actual frontmatter value) instead of `scope: langsensei` (a
  marketplace-fork artifact). [TN-E F2-4]
- **agents**: drop the stale `(see issue #7)` parenthetical from the
  `git-pr` callout in `dev`, `review`, `agent-distill`, `agent-lint`,
  `strategist`, `agent-forge`. [TN-E F3-2]
- **dashboard**: translate 4 Chinese `describe:` strings in
  `mocks/fixtures/schedules.ts` to match the English-default cron
  description convention (PR #230).
