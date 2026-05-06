package kernel

import "errors"

// ErrInvalidTransition is returned by Apply when the requested state
// transition is not legal from the Task's current state.
var ErrInvalidTransition = errors.New("kernel: invalid state transition")

// ErrTaskNotFound is returned by Runtime/Query impls when an operation
// references a TaskID that is not currently tracked.
var ErrTaskNotFound = errors.New("kernel: task not found")
