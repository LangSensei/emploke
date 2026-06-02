# @emploke/e2e

Cross-package end-to-end / integration tests for emploke. **Private
package** — no published artifact, no production code, test-only.

## What lives here

Tests whose subject under test is the **interaction between two or
more packages** (or between emploke and the OS). Tests for a single
package's internals stay in that package's `test/` directory.

```
test/
  architecture/
    inter-service-imports.test.ts    # rule 5: domain pkgs only type-import siblings
    split-convention.test.ts         # facade + sibling-subdir split discipline
    test-layout-convention.test.ts   # test path mirrors src path
    tier-invisibility.test.ts        # T_top fence: dashboard/cli ⊆ {contracts(, server)}
  cli/
    integration-smoke.test.ts        # CLI → real HTTP server round-trips
    spawn-smoke.test.ts              # CLI subprocess lifecycle + bundle smoke
  _helpers/
    cli-bundle.ts                    # shared spawn / port / CLI_BIN resolver
```

Tests are grouped by the **subject** of the test (`test/architecture/`
for repo-wide source-tree audits, `test/cli/` for CLI lifecycle,
future `test/runtime/`, ...) — not by their origin package.

## Why a separate package

Before this package existed, these tests lived under `@emploke/cli`,
which made `pnpm -F @emploke/cli test` carry the cost of a real
server boot (~10 s on Windows) even when the change under test was
pure argv parsing. With the e2e split:

- `@emploke/cli` keeps only fast unit tests (argv parsing, in-process
  API contract via mocked fetch).
- Heavy spawn/boot tests live here and only run when somebody is
  willing to wait for them.

## How to run

The `test/cli/` smoke tests spawn the bundled CLI at
`packages/cli/dist/bin.js`, so a build is required first:

```bash
pnpm --filter @emploke/cli build
pnpm --filter @emploke/e2e test
```

`pnpm -r build && pnpm -r test` (the repo-wide command) runs the
build first so this just works.

The `test/architecture/` audits read source files directly via
`node:fs` walk — they do NOT need a build to run.

## Expected runtime

On Windows, this package's vitest pass is ~10–12 s — the CLI smoke
files each pay one real server boot. On Linux/macOS it's typically
faster because the spawn + SQLite startup paths are cheaper there.
The `test/architecture/` audits add < 1 s each (pure file-tree
walks).

## Future work

Issue #29 (real-spawn runtime layer coverage) is the next planned
addition; one test file per `packages/runtime/dispatch-*` entry point
will land here when scheduled.
