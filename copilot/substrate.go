package copilot

import (
	"github.com/LangSensei/emploke/kernel"
	"github.com/LangSensei/emploke/registry"
)

// Config holds dependencies for the copilot substrate.
type Config struct {
	// Repo persists and retrieves Task state.
	Repo kernel.Repository

	// Agents provides agent profile lookup.
	Agents registry.AgentRegistry

	// Resolver checks capability dependencies.
	Resolver registry.Resolver

	// BaseDir is the root directory for provisioned workspaces.
	// Each task gets a subdirectory named by its TaskID.
	// Defaults to ~/.emploke/tasks if empty.
	BaseDir string
}
