# emploke

*From εμπλοκή (emplokí) — entanglement.*

An agentic framework for building multi-agent systems with pluggable runtime substrates.

## Structure

```
emploke/
├── kernel/               ← Core types, interfaces, Apply (zero dependencies)
├── conformance/
│   └── kernel/           ← Contract tests + reference implementation
├── docs/                 ← Design book
└── go.work
```

### Dependency graph

```
conformance/kernel ──→ kernel
copilot (future)   ──→ kernel
registry (future)  ──→ kernel
```

## Kernel

The kernel defines four axioms (Capability, Agent, Task, Runtime), two invariants, and two interfaces (Runtime + Query).

- **Task** — a pure value type with a six-state machine (`not_started → running → paused → success/failure/cancelled`)
- **Apply** — a pure function: `Apply(task, event) → (task, error)`. No I/O, no locks, no time calls.
- **Runtime** — command interface with six verbs: `Dispatch`, `Pause`, `Resume`, `Kill`, `Complete`, `Fail`
- **Query** — read interface: `Get(id)`, `List(filter...State)`

```go
import "github.com/LangSensei/emploke/kernel"

task := kernel.New("t1", "my-agent", "copilot", "analyze this code")
task, err := kernel.Apply(task, kernel.Dispatched{At: time.Now()})
```

## Conformance

Substrate authors verify their implementation against the contract:

```go
import (
    kerneltest "github.com/LangSensei/emploke/conformance/kernel"
    "github.com/LangSensei/emploke/kernel"
)

func TestConformance(t *testing.T) {
    kerneltest.RunSuite(t, func() (kernel.Runtime, kernel.Query) {
        return myimpl.New()
    })
}
```

## Design Book

See [docs/index.html](docs/index.html) or visit the [published site](https://langsensei.github.io/emploke/).

## License

MIT
