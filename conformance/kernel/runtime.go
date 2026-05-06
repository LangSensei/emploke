package kerneltest

import (
	"context"
	"time"

	"github.com/LangSensei/emploke/kernel"
)

// Runtime is the command-side implementation of kernel.Runtime.
type Runtime struct{ s *store }

// Dispatch implements kernel.Runtime.
func (r *Runtime) Dispatch(_ context.Context, task kernel.Task) error {
	next, err := kernel.Apply(task, kernel.Dispatched{At: time.Now()})
	if err != nil {
		return err
	}
	r.s.mu.Lock()
	defer r.s.mu.Unlock()
	if _, exists := r.s.tasks[next.ID]; exists {
		return kernel.ErrInvalidTransition
	}
	r.s.tasks[next.ID] = next
	return nil
}

// Pause implements kernel.Runtime.
func (r *Runtime) Pause(_ context.Context, id kernel.TaskID) error {
	return r.s.apply(id, kernel.Paused{At: time.Now()})
}

// Resume implements kernel.Runtime.
func (r *Runtime) Resume(_ context.Context, id kernel.TaskID, extra *kernel.Supplement) error {
	return r.s.apply(id, kernel.Resumed{At: time.Now(), Extra: extra})
}

// Kill implements kernel.Runtime.
func (r *Runtime) Kill(_ context.Context, id kernel.TaskID) error {
	return r.s.apply(id, kernel.Cancelled{At: time.Now()})
}

// Complete drives a tracked Task to StateSuccess.
func (r *Runtime) Complete(_ context.Context, id kernel.TaskID, result kernel.Result) error {
	return r.s.apply(id, kernel.Completed{At: time.Now(), Result: result})
}

// Fail drives a tracked Task to StateFailure.
func (r *Runtime) Fail(_ context.Context, id kernel.TaskID, failure kernel.Failure) error {
	return r.s.apply(id, kernel.Failed{At: time.Now(), Failure: failure})
}

// Compile-time interface check.
var _ kernel.Runtime = (*Runtime)(nil)
