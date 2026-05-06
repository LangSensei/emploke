// Package copilot implements [substrate.Runtime] using GitHub Copilot CLI
// as the execution substrate.
//
// Copilot is a library, not a standalone service. It manages CLI processes,
// persists task state via [headless.Repository], and provisions execution
// environments by consulting a [catalog.AgentRegistry]. It does not own
// any network listener or daemon lifecycle — those are product-layer concerns.
//
// # Lifecycle
//
// Dispatch starts a new Copilot CLI process with a generated prompt.
// The process runs until the agent calls back (via product-layer mechanism)
// or the process exits. Pause kills the process; Resume restarts it with
// --resume. Kill terminates the process and marks the task cancelled.
//
// Complete and Fail are called by the product layer when it receives a
// callback from the running agent (e.g. via MCP tool, HTTP, or file).
//
// # Dependencies
//
//   - [kernel]: Task types, Runtime and Repository interfaces
//   - [registry]: AgentRegistry for provisioning (clone repo, resolve capabilities)
//
// Import path:
//
//	import "github.com/LangSensei/emploke/copilot"
package copilot // import "github.com/LangSensei/emploke/copilot"
