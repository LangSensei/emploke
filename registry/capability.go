package registry

import (
	"context"

	"github.com/LangSensei/emploke/kernel"
)

// CapabilityRegistry manages Capability definitions.
//
// Register is idempotent: registering a Capability with the same Name as an
// existing one replaces it. Remove is idempotent: removing a non-existent
// Capability returns nil.
type CapabilityRegistry interface {
	// GetCapability returns the Capability with the given name.
	GetCapability(ctx context.Context, name string) (kernel.Capability, error)

	// ListCapabilities returns all registered Capabilities.
	ListCapabilities(ctx context.Context) ([]kernel.Capability, error)

	// RegisterCapability adds or replaces a Capability.
	RegisterCapability(ctx context.Context, cap kernel.Capability) error

	// RemoveCapability removes the Capability with the given name.
	RemoveCapability(ctx context.Context, name string) error
}
