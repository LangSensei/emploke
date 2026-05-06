package headless

// State is the lifecycle status of a Task.
//
// The kernel mandates exactly six states: three non-terminal
// (not_started, running, paused) and three terminal (success, failure,
// cancelled). Paused and cancelled are first-class — not encoded as
// "blocked" metadata or as a special failure code.
type State string

const (
	StateNotStarted State = "not_started"
	StateRunning    State = "running"
	StatePaused     State = "paused"
	StateSuccess    State = "success"
	StateFailure    State = "failure"
	StateCancelled  State = "cancelled"
)

// IsTerminal reports whether s is a terminal (frozen) state. Terminal Tasks
// never transition again; re-execution is by clone-and-redispatch (construct
// a new Task with a fresh ID; the old one stays as a permanent record).
func (s State) IsTerminal() bool {
	switch s {
	case StateSuccess, StateFailure, StateCancelled:
		return true
	}
	return false
}

// IsActive reports whether s is an in-flight state (running or paused).
func (s State) IsActive() bool {
	return s == StateRunning || s == StatePaused
}
