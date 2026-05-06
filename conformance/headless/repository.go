// package headlesstest is the emploke reference Runtime + Repository implementation.
//
// It tracks Tasks in a process-local map and delegates all state transitions
// to headless.Apply. It performs no real work: a dispatched Task stays running
// until something explicitly completes or fails it via the Runtime's
// Complete and Fail methods.
//
// headlesstest passes the emploke conformance suite.
package headlesstest // import "github.com/LangSensei/emploke/conformance/headless"

import (
	"context"
	"sync"

	"github.com/LangSensei/emploke/session/headless"
)

// Repository is the in-memory reference implementation of [headless.Repository].
type Repository struct {
	mu    sync.Mutex
	tasks map[headless.TaskID]headless.Task
}

func (r *Repository) apply(id headless.TaskID, e headless.Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	task, ok := r.tasks[id]
	if !ok {
		return headless.ErrTaskNotFound
	}
	next, err := headless.Apply(task, e)
	if err != nil {
		return err
	}
	r.tasks[id] = next
	return nil
}

// Save implements [headless.Repository].
func (r *Repository) Save(_ context.Context, task headless.Task) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tasks[task.ID] = task
	return nil
}

// Load implements [headless.Repository].
func (r *Repository) Load(_ context.Context, id headless.TaskID) (headless.Task, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	task, ok := r.tasks[id]
	if !ok {
		return headless.Task{}, headless.ErrTaskNotFound
	}
	return task, nil
}

// List implements [headless.Repository].
func (r *Repository) List(_ context.Context, filter ...headless.State) ([]headless.Task, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	filterSet := make(map[headless.State]bool, len(filter))
	for _, s := range filter {
		filterSet[s] = true
	}
	var result []headless.Task
	for _, task := range r.tasks {
		if len(filterSet) == 0 || filterSet[task.Status] {
			result = append(result, task)
		}
	}
	return result, nil
}

// Delete implements [headless.Repository].
func (r *Repository) Delete(_ context.Context, id headless.TaskID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.tasks, id)
	return nil
}

// New constructs a fresh in-memory Repository and Runtime.
func New() (*Runtime, *Repository) {
	repo := &Repository{tasks: make(map[headless.TaskID]headless.Task)}
	return &Runtime{repo: repo}, repo
}

// Compile-time interface check.
var _ headless.Repository = (*Repository)(nil)
