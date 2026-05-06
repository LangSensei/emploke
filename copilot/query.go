package copilot

import (
	"context"

	"github.com/LangSensei/emploke/kernel"
)

// Query implements [kernel.Query] backed by the copilot Store.
type Query struct {
	store Store
}

// NewQuery creates a Query from the given Store.
func NewQuery(store Store) *Query {
	return &Query{store: store}
}

func (q *Query) Get(_ context.Context, id kernel.TaskID) (kernel.Task, error) {
	return q.store.Load(id)
}

func (q *Query) List(_ context.Context, filter ...kernel.State) ([]kernel.Task, error) {
	return q.store.List(filter...)
}
