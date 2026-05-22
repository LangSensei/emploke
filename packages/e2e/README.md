# @emploke/e2e

Cross-package end-to-end / integration tests for emploke. **Private
package** — no published artifact, no production code, test-only.

## What lives here

Tests whose subject under test is the **interaction between two or
more packages** (or between emploke and the OS). Tests for a single
package's internals stay in that package's `test/` directory.

Today this is the CLI smoke layer:

```
test/
  cli/
    integration-smoke.test.ts   # CLI → real HTTP server round-trips
    spawn-smoke.test.ts         # CLI subprocess lifecycle + bundle smoke
  _helpers/
    cli-bundle.ts               # shared spawn / port / CLI_BIN resolver
```

Tests are grouped by the **subject** of the test (`test/cli/`,
future `test/runtime/`, future `test/task/`), not by their origin
package.

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

The tests spawn the bundled CLI at `packages/cli/dist/bin.js`, so a
build is required first:

```bash
pnpm --filter @emploke/cli build
pnpm --filter @emploke/e2e test
```

`pnpm -r build && pnpm -r test` (the repo-wide command) runs the
build first so this just works.

## Expected runtime

On Windows, this package's vitest pass is ~10–12 s (two test files,
each pays one real server boot). On Linux/macOS it's typically faster
because the spawn + SQLite startup paths are cheaper there.

## Future work

Issue #29 (real-spawn runtime layer coverage) is the next planned
addition; one test file per `packages/runtime/dispatch-*` entry point
will land here when scheduled.
