package copilot

import (
	"github.com/LangSensei/emploke/catalog"
	"github.com/LangSensei/emploke/session/headless"
)

// Config holds dependencies for the copilot substrate.
type Config struct {
	// Repo persists and retrieves Task state.
	Repo headless.Repository

	// Agents provides agent profile lookup.
	Agents catalog.AgentRegistry

	// Resolver checks capability dependencies.
	Resolver catalog.Resolver

	// BaseDir is the root directory for provisioned workspaces.
	// Each task gets a subdirectory named by its TaskID.
	// Defaults to ~/.copilot/tasks if empty.
	BaseDir string
}
