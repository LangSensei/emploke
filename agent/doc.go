// Package agent defines types and interfaces for managing Agents and Capabilities.
//
// Agent and Capability are defined here. The task module only references
// agents by name. This package owns the full definitions including
// capability resolution, dependency analysis, and installation.
//
// Three core interfaces:
//   - [AgentRegistry]: install, remove, get, list Agents
//   - [CapabilityRegistry]: install, remove, get, list Capabilities
//   - [Resolver]: cross-aggregate dependency analysis
//
// [Registry] combines all three for convenience.
//
// Capability names follow the convention "type:scope/name" (e.g.
// "skill:langsensei/xiaohongshu", "mcp:langsensei/playwright").
//
// Import path:
//
//	import "github.com/LangSensei/emploke/agent"
package agent // import "github.com/LangSensei/emploke/agent"
