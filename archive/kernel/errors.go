package kernel

import "errors"

// ErrInvalidTransition is returned by Apply when the requested state
// transition is not legal from the Task's current state.
var ErrInvalidTransition = errors.New("kernel: invalid state transition")

// ErrTaskNotFound is returned by Repository.Load when the requested
// TaskID does not exist in storage.
var ErrTaskNotFound = errors.New("kernel: task not found")
