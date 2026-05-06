// Package kernel is the Layer 1 axiom kernel for agentic systems.
//
// It ships only pure data types (Task, Agent, Capability, Failure, Result,
// Supplement), a pure transition function (Apply), and two interfaces
// (Runtime for commands, Repository for persistence and reads). Zero
// implementations, zero I/O, zero concurrency primitives.
//
// The kernel is fully described by these types plus the Runtime/Repository
// interface contracts; nothing else is required to implement an agentic
// substrate. Concrete substrates live in sibling modules in this repository
// (e.g. emploke/copilot).
//
// See the design book in docs/index.html for the architectural rationale,
// including the six-state Task lifecycle, the Concurrency Contract, and
// the Observability floor (G1).
//
// Import path:
//
//	import "github.com/LangSensei/emploke/kernel"
package kernel // import "github.com/LangSensei/emploke/kernel"
