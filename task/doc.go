// Package task is the data layer for agentic task orchestration.
//
// It ships only pure data types (Task, Failure, Result, Supplement), a pure
// transition function (Apply), and a Repository interface for persistence.
// Zero implementations, zero I/O, zero concurrency primitives.
//
// Agent and Capability definitions live in the agent module. The Runtime
// interface lives in the runtime module. Task only references agents by
// name (Task.AgentName).
//
// Import path:
//
//	import "github.com/LangSensei/emploke/task"
package task // import "github.com/LangSensei/emploke/task"
