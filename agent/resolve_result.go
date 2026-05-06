package agent

// SkillRef points to a skill directory on disk.
type SkillRef struct {
	Name string
	Path string // absolute directory path
}

// MCPRef holds a raw MCP server configuration.
type MCPRef struct {
	Name   string
	Config map[string]any // original json content
}

// ResolveResult holds all resolved resources for provisioning an agent.
// Skills includes the agent itself (as the first entry) plus all
// transitive skill dependencies.
type ResolveResult struct {
	Skills []SkillRef
	MCPs   []MCPRef
}
