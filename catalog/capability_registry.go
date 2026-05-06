package catalog

import (
	"context"
)

// CapabilityRegistry manages Capability definitions.
//
// Register is idempotent: registering a Capability with the same Name as an
// existing one replaces it. Remove is idempotent: removing a non-existent
// Capability returns nil.
type CapabilityRegistry interface {
	// GetCapability returns the Capability with the given name.
	GetCapability(ctx context.Context, name string) (Capability, error)

	// ListCapabilities returns all registered Capabilities.
	ListCapabilities(ctx context.Context) ([]Capability, error)

	// RegisterCapability adds or replaces a Capability.
	RegisterCapability(ctx context.Context, cap Capability) error

	// RemoveCapability removes the Capability with the given name.
	RemoveCapability(ctx context.Context, name string) error
}
