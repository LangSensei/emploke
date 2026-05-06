package registry

import (
	"context"

	"github.com/LangSensei/emploke/kernel"
)

// Resolver provides dependency analysis across Agents and Capabilities.
//
// Resolver is a domain service: it holds no state of its own and composes
// AgentRegistry and CapabilityRegistry to answer cross-aggregate queries.
// Implementations receive both registries at construction time.
type Resolver interface {
	// Resolve returns the concrete Capabilities required by the Agent.
	// Returns error if any required Capability is not registered.
	Resolve(ctx context.Context, agent kernel.Agent) ([]kernel.Capability, error)

	// Missing returns Capability names required by the Agent but not
	// registered. Returns nil when all dependencies are satisfied.
	Missing(ctx context.Context, agent kernel.Agent) ([]string, error)

	// Dependents returns Agents that declare the given Capability name
	// in their Capabilities list.
	Dependents(ctx context.Context, capName string) ([]kernel.Agent, error)

	// Orphans returns registered Capabilities that are not required by
	// any registered Agent.
	Orphans(ctx context.Context) ([]kernel.Capability, error)
}
