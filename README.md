# Emploke

> *From εμπλοκή (emplokí) — entanglement.*
>
> Layer 1 axiom kernel for agentic systems — pure data types, pure transition function, zero implementations.

Emploke ships **only** pure data types (`Task`, `Agent`, `Capability`, `Failure`, `Result`, `Supplement`), a pure transition function (`Apply`), and two interfaces (`Runtime` for commands, `Query` for reads). Zero implementations, zero I/O, zero concurrency primitives. Concrete substrates (Copilot CLI, OpenAI, Claude, etc.) live as sibling modules in this repository.

## Repository layout

| Path | Module | Purpose |
|------|--------|---------|
| `/kernel` | `github.com/LangSensei/emploke/kernel` | Kernel — Task aggregate, Apply transition function, Runtime/Query interfaces, value objects |
| `/conformance/kernel` | `github.com/LangSensei/emploke/conformance/kernel` | Contract tests + reference implementation — every Runtime+Query impl runs this suite |
| `/registry` | `github.com/LangSensei/emploke/registry` | AgentRegistry + CapabilityRegistry interfaces |
| `/docs` | — | Architectural design book (see [Design book](#design-book)) |

### Dependency graph

```
conformance/kernel ──→ kernel
registry           ──→ kernel
copilot (future)   ──→ kernel, registry
```

## Quick start

```go
import (
    "context"

    "github.com/LangSensei/emploke/kernel"
    kerneltest "github.com/LangSensei/emploke/conformance/kernel"
)

func main() {
    ctx := context.Background()
    rt, q := kerneltest.New()

    task := kernel.New("t1", "agent-1", "inmemory", "do the thing")

    if err := rt.Dispatch(ctx, task); err != nil { /* ... */ }

    // Query to observe state (CQRS read side)
    got, _ := q.Get(ctx, task.ID)
    // got.Status == kernel.StateRunning

    _ = rt.Complete(ctx, task.ID, kernel.Result{Payload: "ok"})

    got, _ = q.Get(ctx, task.ID)
    // got.Status == kernel.StateSuccess
}
```

## Runtime interface (6 verbs)

```go
type Runtime interface {
    Dispatch(ctx context.Context, task Task) error
    Pause(ctx context.Context, id TaskID) error
    Resume(ctx context.Context, id TaskID, extra *Supplement) error
    Kill(ctx context.Context, id TaskID) error
    Complete(ctx context.Context, id TaskID, result Result) error
    Fail(ctx context.Context, id TaskID, failure Failure) error
}
```

The signatures are deliberately asymmetric: `Dispatch` takes the whole `Task` (the materialisation moment); the other five take only `TaskID` (the Task is already materialised).

## Query interface (CQRS read side)

```go
type Query interface {
    Get(ctx context.Context, id TaskID) (Task, error)
    List(ctx context.Context, filter ...State) ([]Task, error)
}
```

Components that only need to observe (dashboards, monitors, webhooks) depend on `Query` alone.

## The six Task states

```
not_started ──► running ⇄ paused
                  │         │
                  ▼         ▼
              success / failure / cancelled  (terminal)
```

Terminal Tasks are forever frozen. Re-execution is by clone-and-redispatch (construct a new Task with a fresh ID; record lineage in `Metadata`). The kernel exposes no `reset` or `retry` verb.

## Pure transition function

All state transitions go through a single pure function:

```go
func Apply(task Task, event Event) (Task, error)
```

`Apply` has no side effects — no I/O, no locks, no time calls (timestamps come from the Event). Concurrency control is the responsibility of the Runtime/Query implementation.

## Writing a new substrate

1. Implement the `kernel.Runtime` and `kernel.Query` interfaces.
2. In your tests, call `kerneltest.RunSuite` to verify the impl satisfies the contract.

```go
import (
    "testing"

    kerneltest "github.com/LangSensei/emploke/conformance/kernel"
    "github.com/LangSensei/emploke/kernel"
)

func TestConformance(t *testing.T) {
    kerneltest.RunSuite(t, func() (kernel.Runtime, kernel.Query) {
        return mysubstrate.New()
    })
}
```

## Development

This repo is a Go [multi-module workspace](https://go.dev/ref/mod#workspaces). The `go.work` file is committed:

```sh
go test ./kernel/... ./conformance/kernel/...
```

## Design book

The full architectural rationale — including the six-state Task lifecycle, the Concurrency Contract, and the Observability floor (G1) — lives in [`docs/index.html`](docs/index.html).

Read online: **<https://langsensei.github.io/emploke/>**

The book is bilingual (English + 中文).

## License

MIT
