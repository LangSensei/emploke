// Package substrate defines execution-side contracts that concrete runtime
// implementations must satisfy.
//
// A "substrate" is anything capable of actually running an agent — for
// example, GitHub Copilot CLI, Claude Code, a local LLM wrapper, etc. Each
// substrate lives in its own subpackage (e.g. substrate/copilot) and
// implements the contracts defined here.
//
// Currently the only contract is [Runtime] (for headless tasks). When
// interactive sessions are added, a parallel [Manager] contract will live
// here as well.
//
// substrate depends on session/headless (for the Task data types its Runtime
// operates on); session/headless does NOT depend on substrate.
package substrate
