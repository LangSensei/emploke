// Package tasktest is the emploke reference Runtime + Repository implementation.
//
// It tracks Tasks in a process-local map and delegates all state transitions
// to task.Apply. It performs no real work: a dispatched Task stays running
// until something explicitly completes or fails it via the Runtime's
// Complete and Fail methods.
package tasktest

import (
	"context"
	"sync"

	"github.com/LangSensei/emploke/task"
)

// Repository is the in-memory reference implementation of [task.Repository].
type Repository struct {
	mu    sync.Mutex
	tasks map[task.TaskID]task.Task
}

func (r *Repository) apply(id task.TaskID, e task.Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tasks[id]
	if !ok {
		return task.ErrTaskNotFound
	}
	next, err := task.Apply(t, e)
	if err != nil {
		return err
	}
	r.tasks[id] = next
	return nil
}

// Save implements [task.Repository].
func (r *Repository) Save(_ context.Context, t task.Task) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tasks[t.ID] = t
	return nil
}

// Load implements [task.Repository].
func (r *Repository) Load(_ context.Context, id task.TaskID) (task.Task, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tasks[id]
	if !ok {
		return task.Task{}, task.ErrTaskNotFound
	}
	return t, nil
}

// List implements [task.Repository].
func (r *Repository) List(_ context.Context, filter ...task.State) ([]task.Task, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	filterSet := make(map[task.State]bool, len(filter))
	for _, s := range filter {
		filterSet[s] = true
	}
	var result []task.Task
	for _, t := range r.tasks {
		if len(filterSet) == 0 || filterSet[t.Status] {
			result = append(result, t)
		}
	}
	return result, nil
}

// Delete implements [task.Repository].
func (r *Repository) Delete(_ context.Context, id task.TaskID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.tasks, id)
	return nil
}

// New constructs a fresh in-memory Repository and Runtime.
func New() (*Runtime, *Repository) {
	repo := &Repository{tasks: make(map[task.TaskID]task.Task)}
	return &Runtime{repo: repo}, repo
}

// Compile-time interface check.
var _ task.Repository = (*Repository)(nil)
