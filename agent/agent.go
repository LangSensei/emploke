package agent

import "context"

// Agent is a named bundle of capabilities.
//
// Agent has no separate id; the scoped Name is the unique handle.
// Capabilities is a flat list of capability references (e.g.
// "skill:langsensei/xiaohongshu", "mcp:langsensei/playwright").
type Agent struct {
	Name         string
	Capabilities []string
	Metadata     map[string]any
}

// AgentRegistry manages Agent profiles.
//
// Install is idempotent: installing an Agent with the same Name as an
// existing one replaces it. Remove is idempotent: removing a non-existent
// Agent returns nil.
type AgentRegistry interface {
	// GetAgent returns the Agent with the given name.
	// Metadata and Capabilities are populated by parsing the underlying files.
	GetAgent(ctx context.Context, name string) (Agent, error)

	// ListAgents returns all registered Agents.
	ListAgents(ctx context.Context) ([]Agent, error)

	// InstallAgent copies an agent from srcPath (directory containing AGENT.md)
	// into the registry.
	InstallAgent(ctx context.Context, name string, srcPath string) error

	// RemoveAgent removes the Agent with the given name.
	RemoveAgent(ctx context.Context, name string) error
}
