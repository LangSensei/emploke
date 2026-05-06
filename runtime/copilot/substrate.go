package copilot

import (
	agentfs "github.com/LangSensei/emploke/agent/fs"
	"github.com/LangSensei/emploke/task"
)

// Config holds dependencies for the copilot substrate.
type Config struct {
	// Repo persists and retrieves Task state.
	Repo task.Repository

	// Registry provides agent lookup and capability resolution.
	Registry *agentfs.Registry

	// BaseDir is the root directory for provisioned workspaces.
	// Each task gets a subdirectory named by its TaskID.
	// Defaults to ~/.copilot/tasks if empty.
	BaseDir string
}
