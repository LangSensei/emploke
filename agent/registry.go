package agent

// Registry combines AgentRegistry, CapabilityRegistry, and Resolver
// into a single interface for convenience.
//
// Implementations that provide all three may implement Registry directly.
// Callers that only need a subset should accept the narrower interface.
type Registry interface {
	AgentRegistry
	CapabilityRegistry
	Resolver
}
