# Emploke

> *From εμπλοκή (emplokí) — entanglement.*
>
> Agentic workflow framework — pure data types, pure transition functions, contracts split by bounded context.

Emploke is organised around **two layers** and **two bounded contexts**:

- **Framework** (the axioms) — minimal, opinion-free, stable.
- **Convention** (everything else) — methodologies, roles, workflows are built on top.

The framework currently ships one bounded context (`session/headless`) plus
its execution contract (`substrate`) and a catalog domain for agent/capability
descriptions. A second bounded context (`session/interactive`) for PTY-based
chat sessions is planned.

## Repository layout

| Path | Module | Purpose |
|------|--------|---------|
| `/session` | — | Parent namespace for session bounded contexts (no code, doc only) |
| `/session/headless` | `…/session/headless` | Headless Task aggregate, 6-state lifecycle, `Apply` transition fn, `Repository` interface |
| `/catalog` | `…/catalog` | `Agent`, `Capability` value objects + `AgentRegistry`/`CapabilityRegistry`/`Resolver` interfaces |
| `/catalog/fs` | `…/catalog/fs` | File-system implementation of the catalog interfaces |
| `/substrate` | `…/substrate` | `Runtime` interface — execution-side contract that substrates implement |
| `/substrate/copilot` | `…/substrate/copilot` | Copilot CLI substrate (`Runtime` implementation, mockable for tests) |
| `/conformance/headless` | `…/conformance/headless` | Contract tests + reference impl for headless Runtime+Repository |
| `/docs` | — | Architectural design book |

### Dependency graph

```
session/headless          (no deps; pure data + state machine)

catalog                   (no deps; pure value objects + interfaces)
catalog/fs        ──→ catalog

substrate         ──→ session/headless
substrate/copilot ──→ session/headless, substrate, catalog

conformance/headless ──→ session/headless, substrate
```

Notes:
- `session/headless` does **not** depend on `substrate` — the data
  types are independent of how anything runs.
- `Runtime` interface lives in `substrate/`, not in `session/headless/`,
  because it is the execution-side contract (analogous to `database/sql/driver`).
- `Repository` interface lives in `session/headless/`, because it
  is the data-side contract for storing Task state.
- `catalog` is independent of `session/headless`; the headless `Task` only
  references an agent by name (`AgentName string`).

## Quick start

```go
import (
    "context"

    "github.com/LangSensei/emploke/session/headless"
    headlesstest "github.com/LangSensei/emploke/conformance/headless"
)

func main() {
    ctx := context.Background()
    rt, repo := headlesstest.New()

    task := headless.New("t1", "agent-1", "inmemory", "do the thing")

    if err := rt.Dispatch(ctx, task); err != nil { /* ... */ }

    got, _ := repo.Load(ctx, task.ID)
    // got.Status == headless.StateRunning

    _ = rt.Complete(ctx, task.ID, headless.Result{Payload: "ok"})

    got, _ = repo.Load(ctx, task.ID)
    // got.Status == headless.StateSuccess
}
```

## Runtime interface (6 verbs)

Defined in `substrate`:

```go
type Runtime interface {
    Dispatch(ctx context.Context, task headless.Task) error
    Pause(ctx context.Context, id headless.TaskID) error
    Resume(ctx context.Context, id headless.TaskID, extra *headless.Supplement) error
    Kill(ctx context.Context, id headless.TaskID) error
    Complete(ctx context.Context, id headless.TaskID, result headless.Result) error
    Fail(ctx context.Context, id headless.TaskID, failure headless.Failure) error
}
```

Asymmetric by design: `Dispatch` takes the whole `Task` (the materialisation
moment); the other five take only `TaskID` (the Task is already materialised).

## Repository interface

Defined in `session/headless`:

```go
type Repository interface {
    Save(ctx context.Context, task Task) error
    Load(ctx context.Context, id TaskID) (Task, error)
    List(ctx context.Context, filter ...State) ([]Task, error)
    Delete(ctx context.Context, id TaskID) error
}
```

## The six Task states

```
not_started ──► running ⇄ paused
                  │         │
                  ▼         ▼
              success / failure / cancelled  (terminal)
```

Terminal Tasks are forever frozen. Re-execution is by clone-and-redispatch.

## Pure transition function

```go
func Apply(task Task, event Event) (Task, error)
```

`Apply` has no side effects — no I/O, no locks, no time calls. Concurrency
control is the responsibility of the Runtime/Repository implementation.

## Writing a new substrate

1. Implement `substrate.Runtime`.
2. Provide or reuse a `headless.Repository` implementation.
3. Verify with the conformance suite:

```go
import (
    "testing"

    headlesstest "github.com/LangSensei/emploke/conformance/headless"
    "github.com/LangSensei/emploke/session/headless"
    "github.com/LangSensei/emploke/substrate"
)

func TestConformance(t *testing.T) {
    headlesstest.RunSuite(t, func() (substrate.Runtime, headless.Repository) {
        return mysubstrate.New()
    })
}
```

## Development

This repo is a Go [multi-module workspace](https://go.dev/ref/mod#workspaces).
The `go.work` file is committed:

```sh
go test ./session/headless/... \
        ./catalog/... ./catalog/fs/... \
        ./substrate/... ./substrate/copilot/... \
        ./conformance/headless/...
```

## Design book

The full architectural rationale lives in [`docs/index.html`](docs/index.html).

Read online: **<https://langsensei.github.io/emploke/>**

## License

MIT