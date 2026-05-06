package headlesstest

import (
	"context"
	"time"

	"github.com/LangSensei/emploke/session/headless"
	"github.com/LangSensei/emploke/substrate"
)

// Runtime is the command-side implementation of substrate.Runtime.
type Runtime struct{ repo *Repository }

// Dispatch implements substrate.Runtime.
func (r *Runtime) Dispatch(_ context.Context, task headless.Task) error {
	next, err := headless.Apply(task, headless.Dispatched{At: time.Now()})
	if err != nil {
		return err
	}
	r.repo.mu.Lock()
	defer r.repo.mu.Unlock()
	if _, exists := r.repo.tasks[next.ID]; exists {
		return headless.ErrInvalidTransition
	}
	r.repo.tasks[next.ID] = next
	return nil
}

// Pause implements substrate.Runtime.
func (r *Runtime) Pause(_ context.Context, id headless.TaskID) error {
	return r.repo.apply(id, headless.Paused{At: time.Now()})
}

// Resume implements substrate.Runtime.
func (r *Runtime) Resume(_ context.Context, id headless.TaskID, extra *headless.Supplement) error {
	return r.repo.apply(id, headless.Resumed{At: time.Now(), Extra: extra})
}

// Kill implements substrate.Runtime.
func (r *Runtime) Kill(_ context.Context, id headless.TaskID) error {
	return r.repo.apply(id, headless.Cancelled{At: time.Now()})
}

// Complete drives a tracked Task to StateSuccess.
func (r *Runtime) Complete(_ context.Context, id headless.TaskID, result headless.Result) error {
	return r.repo.apply(id, headless.Completed{At: time.Now(), Result: result})
}

// Fail drives a tracked Task to StateFailure.
func (r *Runtime) Fail(_ context.Context, id headless.TaskID, failure headless.Failure) error {
	return r.repo.apply(id, headless.Failed{At: time.Now(), Failure: failure})
}

// Compile-time interface check.
var _ substrate.Runtime = (*Runtime)(nil)
