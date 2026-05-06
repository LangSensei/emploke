package tasktest

import (
	"context"
	"time"

	"github.com/LangSensei/emploke/task"
)

// Runtime is the command-side implementation.
type Runtime struct{ repo *Repository }

// Dispatch implements runtime.Runtime.
func (r *Runtime) Dispatch(_ context.Context, t task.Task) error {
	next, err := task.Apply(t, task.Dispatched{At: time.Now()})
	if err != nil {
		return err
	}
	r.repo.mu.Lock()
	defer r.repo.mu.Unlock()
	if _, exists := r.repo.tasks[next.ID]; exists {
		return task.ErrInvalidTransition
	}
	r.repo.tasks[next.ID] = next
	return nil
}

// Pause implements runtime.Runtime.
func (r *Runtime) Pause(_ context.Context, id task.TaskID) error {
	return r.repo.apply(id, task.Paused{At: time.Now()})
}

// Resume implements runtime.Runtime.
func (r *Runtime) Resume(_ context.Context, id task.TaskID, extra *task.Supplement) error {
	return r.repo.apply(id, task.Resumed{At: time.Now(), Extra: extra})
}

// Kill implements runtime.Runtime.
func (r *Runtime) Kill(_ context.Context, id task.TaskID) error {
	return r.repo.apply(id, task.Cancelled{At: time.Now()})
}

// Complete drives a tracked Task to StateSuccess.
func (r *Runtime) Complete(_ context.Context, id task.TaskID, result task.Result) error {
	return r.repo.apply(id, task.Completed{At: time.Now(), Result: result})
}

// Fail drives a tracked Task to StateFailure.
func (r *Runtime) Fail(_ context.Context, id task.TaskID, failure task.Failure) error {
	return r.repo.apply(id, task.Failed{At: time.Now(), Failure: failure})
}
