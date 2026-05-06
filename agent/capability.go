package agent

import "context"

// Capability is a named ability registered in the system.
//
// Capabilities are identified by a qualified name with type prefix and scope:
// "skill:<scope>/<name>" or "mcp:<scope>/<name>".
//
// Capabilities can declare their own dependencies via the Capabilities field,
// enabling recursive resolution.
type Capability struct {
	Name         string
	Capabilities []string // recursive dependencies
	Metadata     map[string]any
}

// CapabilityRegistry manages Capability definitions.
//
// Install is idempotent: installing a Capability with the same Name as an
// existing one replaces it. Remove is idempotent: removing a non-existent
// Capability returns nil.
type CapabilityRegistry interface {
	// GetCapability returns the Capability with the given name.
	// Metadata is populated by parsing the underlying files.
	GetCapability(ctx context.Context, name string) (Capability, error)

	// ListCapabilities returns all registered Capabilities.
	ListCapabilities(ctx context.Context) ([]Capability, error)

	// Install copies a capability from srcPath into the registry.
	// If srcPath is a directory (containing SKILL.md), it's installed as a skill.
	// If srcPath is a .json file, it's installed as an MCP.
	Install(ctx context.Context, name string, srcPath string) error

	// Remove deletes the Capability with the given name.
	Remove(ctx context.Context, name string) error
}
