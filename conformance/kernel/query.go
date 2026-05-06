package kerneltest

import (
	"context"

	"github.com/LangSensei/emploke/kernel"
)

// Query is the read-side implementation of kernel.Query.
type Query struct{ s *store }

// Get implements kernel.Query.
func (q *Query) Get(_ context.Context, id kernel.TaskID) (kernel.Task, error) {
	q.s.mu.Lock()
	defer q.s.mu.Unlock()
	task, ok := q.s.tasks[id]
	if !ok {
		return kernel.Task{}, kernel.ErrTaskNotFound
	}
	return task, nil
}

// List implements kernel.Query.
func (q *Query) List(_ context.Context, filter ...kernel.State) ([]kernel.Task, error) {
	q.s.mu.Lock()
	defer q.s.mu.Unlock()
	filterSet := make(map[kernel.State]bool, len(filter))
	for _, s := range filter {
		filterSet[s] = true
	}
	var result []kernel.Task
	for _, task := range q.s.tasks {
		if len(filterSet) == 0 || filterSet[task.Status] {
			result = append(result, task)
		}
	}
	return result, nil
}

// Compile-time interface check.
var _ kernel.Query = (*Query)(nil)
