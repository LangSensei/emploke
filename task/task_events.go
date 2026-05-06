package task

import "time"

// Event represents a domain event that triggers a Task state transition.
type Event interface {
	event() // sealed marker
}

// Dispatched transitions not_started → running.
type Dispatched struct{ At time.Time }

// Paused transitions running → paused.
type Paused struct{ At time.Time }

// Resumed transitions paused → running, optionally appending a Supplement.
type Resumed struct {
	At    time.Time
	Extra *Supplement
}

// Completed transitions running → success.
type Completed struct {
	At     time.Time
	Result Result
}

// Failed transitions running → failure.
type Failed struct {
	At      time.Time
	Failure Failure
}

// Cancelled transitions any non-terminal state → cancelled.
// On a terminal Task this is a no-op (returns unchanged Task, nil error).
type Cancelled struct{ At time.Time }

func (Dispatched) event() {}
func (Paused) event()     {}
func (Resumed) event()    {}
func (Completed) event()  {}
func (Failed) event()     {}
func (Cancelled) event()  {}
