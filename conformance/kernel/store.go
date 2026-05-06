// Package kerneltest is the emploke reference Runtime + Repository implementation.
//
// It tracks Tasks in a process-local map and delegates all state transitions
// to kernel.Apply. It performs no real work: a dispatched Task stays running
// until something explicitly completes or fails it via the Runtime's
// Complete and Fail methods.
//
// kerneltest passes the emploke conformance suite.
package kerneltest // import "github.com/LangSensei/emploke/conformance/kernel"

import (
	"context"
	"sync"

	"github.com/LangSensei/emploke/kernel"
)

// Repository is the in-memory reference implementation of [kernel.Repository].
type Repository struct {
	mu    sync.Mutex
	tasks map[kernel.TaskID]kernel.Task
}

func (r *Repository) apply(id kernel.TaskID, e kernel.Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	task, ok := r.tasks[id]
	if !ok {
		return kernel.ErrTaskNotFound
	}
	next, err := kernel.Apply(task, e)
	if err != nil {
		return err
	}
	r.tasks[id] = next
	return nil
}

// Save implements [kernel.Repository].
func (r *Repository) Save(_ context.Context, task kernel.Task) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tasks[task.ID] = task
	return nil
}

// Load implements [kernel.Repository].
func (r *Repository) Load(_ context.Context, id kernel.TaskID) (kernel.Task, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	task, ok := r.tasks[id]
	if !ok {
		return kernel.Task{}, kernel.ErrTaskNotFound
	}
	return task, nil
}

// List implements [kernel.Repository].
func (r *Repository) List(_ context.Context, filter ...kernel.State) ([]kernel.Task, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	filterSet := make(map[kernel.State]bool, len(filter))
	for _, s := range filter {
		filterSet[s] = true
	}
	var result []kernel.Task
	for _, task := range r.tasks {
		if len(filterSet) == 0 || filterSet[task.Status] {
			result = append(result, task)
		}
	}
	return result, nil
}

// Delete implements [kernel.Repository].
func (r *Repository) Delete(_ context.Context, id kernel.TaskID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.tasks, id)
	return nil
}

// New constructs a fresh in-memory Repository and Runtime.
func New() (*Runtime, *Repository) {
	repo := &Repository{tasks: make(map[kernel.TaskID]kernel.Task)}
	return &Runtime{repo: repo}, repo
}

// Compile-time interface check.
var _ kernel.Repository = (*Repository)(nil)
