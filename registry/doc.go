// Package registry defines interfaces for managing Agents and Capabilities.
//
// Registry is the bridge between the kernel's axioms (Agent, Capability) and
// the product layer's concrete storage. The kernel defines what an Agent and
// Capability are; the registry defines how to store, retrieve, and remove them.
//
// Three core interfaces:
//   - [AgentRegistry]: CRUD for kernel.Agent
//   - [CapabilityRegistry]: CRUD for kernel.Capability
//   - [Resolver]: cross-aggregate dependency analysis (resolve, missing, dependents, orphans)
//
// [Registry] combines all three for convenience.
//
// Implementations may back these interfaces with files (SKILL.md frontmatter),
// databases, remote APIs, or in-memory maps. The registry package itself ships
// no concrete implementation.
//
// Import path:
//
//	import "github.com/LangSensei/emploke/registry"
package registry // import "github.com/LangSensei/emploke/registry"
