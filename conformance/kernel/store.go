// Package kerneltest is the emploke reference Runtime + Query implementation.
//
// It tracks Tasks in a process-local map and delegates all state transitions
// to kernel.Apply. It performs no real work: a dispatched Task stays running
// until something explicitly completes or fails it via the Runtime's
// Complete and Fail methods.
//
// kerneltest passes the emploke conformance suite.
package kerneltest // import "github.com/LangSensei/emploke/conformance/kernel"

import (
	"sync"

	"github.com/LangSensei/emploke/kernel"
)

// store is the shared state between Runtime and Query.
type store struct {
	mu    sync.Mutex
	tasks map[kernel.TaskID]kernel.Task
}

func (s *store) apply(id kernel.TaskID, e kernel.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[id]
	if !ok {
		return kernel.ErrTaskNotFound
	}
	next, err := kernel.Apply(task, e)
	if err != nil {
		return err
	}
	s.tasks[id] = next
	return nil
}

// New constructs a fresh inmemory store and returns the Runtime and Query
// views over it.
func New() (*Runtime, *Query) {
	s := &store{tasks: make(map[kernel.TaskID]kernel.Task)}
	return &Runtime{s: s}, &Query{s: s}
}
