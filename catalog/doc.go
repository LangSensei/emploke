// Package catalog defines the Agent and Capability domain: what agents are,
// what capabilities they declare, and how they are stored, looked up, and
// resolved.
//
// An Agent is a named bundle of capabilities; a Capability is a named ability
// (skill, MCP, etc.) that an Agent may have. Both are pure value objects with
// no lifecycle of their own — the catalog manages their storage and
// resolution, but they have no state machine.
//
// Three core interfaces:
//   - [AgentRegistry]: CRUD for Agent profiles
//   - [CapabilityRegistry]: CRUD for Capability definitions
//   - [Resolver]: cross-aggregate analysis (resolve, missing, dependents, orphans)
//
// [Registry] composes all three for convenience; callers needing only one
// concern should accept the narrower interface.
//
// catalog defines no concrete storage; implementations (file system,
// database, remote API, in-memory) live in subpackages and sibling modules
// such as catalog/fs.
//
// Import path:
//
//	import "github.com/LangSensei/emploke/catalog"
package catalog // import "github.com/LangSensei/emploke/catalog"
