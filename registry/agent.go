package registry

import (
	"context"

	"github.com/LangSensei/emploke/kernel"
)

// AgentRegistry manages Agent profiles.
//
// Register is idempotent: registering an Agent with the same Name as an
// existing one replaces it. Remove is idempotent: removing a non-existent
// Agent returns nil.
type AgentRegistry interface {
	// GetAgent returns the Agent with the given name.
	GetAgent(ctx context.Context, name string) (kernel.Agent, error)

	// ListAgents returns all registered Agents.
	ListAgents(ctx context.Context) ([]kernel.Agent, error)

	// RegisterAgent adds or replaces an Agent.
	RegisterAgent(ctx context.Context, agent kernel.Agent) error

	// RemoveAgent removes the Agent with the given name.
	RemoveAgent(ctx context.Context, name string) error
}
