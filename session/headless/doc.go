// Package headless defines the headless session domain: a Task aggregate
// with a 6-state lifecycle and a pure Apply transition function.
//
// A headless session is a one-shot, goal-driven execution: an agent receives
// instructions, runs to completion, and reports a Result or Failure. There is
// no mid-flight user interaction; the only inputs after dispatch are
// Pause/Resume/Kill commands and an optional Supplement on Resume.
//
// This package owns:
//   - The Task aggregate (data only, no methods that mutate)
//   - The State enum and the Apply pure function (state machine)
//   - The Repository interface (storage contract)
//   - Value types: Result, Failure, Supplement, TaskID
//
// Runtime, the execution-side contract, lives in the sibling
// "github.com/LangSensei/emploke/substrate" package. Headless does not depend
// on substrate.
//
// Concurrency control and persistence are responsibilities of substrates and
// repository implementations; the headless package is concurrency-free.
//
// Import path:
//
//	import "github.com/LangSensei/emploke/session/headless"
package headless // import "github.com/LangSensei/emploke/session/headless"
