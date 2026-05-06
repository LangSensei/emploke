package kernel

// Capability is a named ability that an Agent may have.
//
// Capabilities are value objects: defined by name alone, no identity, no
// lifecycle. The kernel does not interpret, validate, or enumerate capability
// names — they are opaque handles whose meaning is defined by the layer above.
//
// Metadata carries product-specific data (e.g. transport, configuration).
// The kernel never reads or writes Metadata; it only stores and forwards it.
type Capability struct {
	Name     string
	Metadata map[string]any
}
