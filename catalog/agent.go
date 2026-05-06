package catalog

// Agent is a value object: a scoped, named bundle of capabilities.
//
// Agent has no separate id; the scoped Name is the unique handle. Agent is
// not bound to any Runtime substrate — runtime_kind lives on Task, not on
// Agent. This lets the same Agent execute on different substrates over time
// (migration, A/B, fallback, local vs remote).
type Agent struct {
	Name         string
	Capabilities []Capability
	Metadata     map[string]any
}
