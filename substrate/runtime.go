package substrate

import (
	"context"

	"github.com/LangSensei/emploke/session/headless"
)

// Runtime is the command-side interface for controlling headless.Task execution.
//
// Runtime is responsible for: accepting new Tasks, pausing/resuming/killing
// active Tasks, and driving state transitions via [headless.Apply]. Concurrency
// control and persistence are implementation concerns.
//
// The verbs are deliberately asymmetric:
//   - Dispatch takes the whole Task (the materialisation moment).
//   - All other verbs take only the TaskID (the Task is already materialised).
type Runtime interface {
	// Dispatch starts executing task. On success the Task transitions
	// not_started → running.
	Dispatch(ctx context.Context, task headless.Task) error

	// Pause requests that the Task halt at the next safe checkpoint.
	Pause(ctx context.Context, id headless.TaskID) error

	// Resume requests that a paused Task continue executing, optionally
	// appending a Supplement.
	Resume(ctx context.Context, id headless.TaskID, extra *headless.Supplement) error

	// Kill requests cancellation. Idempotent on terminal Tasks.
	Kill(ctx context.Context, id headless.TaskID) error

	// Complete reports that the Task finished successfully.
	Complete(ctx context.Context, id headless.TaskID, result headless.Result) error

	// Fail reports that the Task finished with a Failure.
	Fail(ctx context.Context, id headless.TaskID, failure headless.Failure) error
}
