package kernel

import "context"

// Runtime is the command-side interface for controlling Task execution.
//
// Runtime is responsible for: accepting new Tasks, pausing/resuming/killing
// active Tasks, and driving state transitions via Apply. Concurrency control
// and persistence are impl concerns.
//
// The four verbs are deliberately asymmetric:
//   - Dispatch takes the whole Task (the materialisation moment).
//   - Pause / Resume / Kill take only TaskID (Task is already materialised).
type Runtime interface {
	// Dispatch starts executing task. On success the Task transitions
	// not_started → running.
	Dispatch(ctx context.Context, task Task) error

	// Pause requests that the Task halt at the next safe checkpoint.
	Pause(ctx context.Context, id TaskID) error

	// Resume requests that a paused Task continue executing.
	Resume(ctx context.Context, id TaskID, extra *Supplement) error

	// Kill requests cancellation. Idempotent on terminal Tasks.
	Kill(ctx context.Context, id TaskID) error

	// Complete reports that the Task finished successfully.
	Complete(ctx context.Context, id TaskID, result Result) error

	// Fail reports that the Task finished with a failure.
	Fail(ctx context.Context, id TaskID, failure Failure) error
}
