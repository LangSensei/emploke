package task

import "time"

// Task is the kernel's only Aggregate Root — a pure, serializable data type.
//
// Task carries no mutex, no methods that mutate state. All state transitions
// happen through the Apply pure function. Concurrency control is the
// responsibility of the Runtime/Query implementation, not of Task itself.
type Task struct {
	ID           TaskID
	AgentName    string
	RuntimeKind  string
	Instructions string
	Metadata     map[string]any

	Status      State
	StartedAt   *time.Time
	EndedAt     *time.Time
	Result      *Result
	Failure     *Failure
	Supplements []Supplement
}

// New constructs a Task in StateNotStarted.
func New(id TaskID, agentName, runtimeKind, instructions string) Task {
	return Task{
		ID:           id,
		AgentName:    agentName,
		RuntimeKind:  runtimeKind,
		Instructions: instructions,
		Status:       StateNotStarted,
	}
}
