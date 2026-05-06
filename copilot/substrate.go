package copilot

import (
	"github.com/LangSensei/emploke/kernel"
	"github.com/LangSensei/emploke/registry"
)

// Store persists Task state to durable storage.
//
// Implementations are expected to be file-system based (one file per task),
// but the interface does not prescribe the format or layout.
type Store interface {
	// Save persists the current state of a Task.
	Save(task kernel.Task) error

	// Load retrieves a Task by its ID.
	Load(id kernel.TaskID) (kernel.Task, error)

	// List returns all persisted Tasks, optionally filtered by state.
	List(filter ...kernel.State) ([]kernel.Task, error)

	// Delete removes a Task from storage.
	Delete(id kernel.TaskID) error
}

// Provisioner prepares an execution environment for a Task.
//
// The provisioner consults the registry to resolve the agent profile and
// its capabilities, then sets up the working directory (clone repo, write
// MCP config, inject instructions, install dependencies).
type Provisioner interface {
	// Provision prepares the environment and returns the working directory.
	Provision(task kernel.Task, agent kernel.Agent) (workdir string, err error)

	// Cleanup removes the provisioned environment.
	Cleanup(id kernel.TaskID) error
}

// ProcessManager manages Copilot CLI child processes.
type ProcessManager interface {
	// Start launches a new Copilot CLI process and returns a session ID.
	Start(workdir string, prompt string) (sessionID string, err error)

	// Resume restarts a previously paused session.
	Resume(sessionID string, prompt string) error

	// Kill terminates a running process.
	Kill(sessionID string) error

	// Wait blocks until the process exits and returns the exit code.
	Wait(sessionID string) (exitCode int, err error)

	// IsRunning reports whether the process is still alive.
	IsRunning(sessionID string) bool
}

// Config holds dependencies for the copilot substrate.
type Config struct {
	Store          Store
	Provisioner    Provisioner
	ProcessManager ProcessManager
	Agents         registry.AgentRegistry
	Resolver       registry.Resolver
}
