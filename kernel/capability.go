package kernel

// Capability is a named ability that an Agent may have.
//
// Capabilities are value objects: defined by name alone, no identity, no
// lifecycle. They are loadable — populated by the layer above the kernel
// (e.g. a registry), not enumerated by the kernel itself.
type Capability struct {
	Name string
}
