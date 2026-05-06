package kernel

import "context"

// Query is the read-side interface for observing Task state.
//
// Query is separated from Runtime (CQRS): components that only need to
// observe (dashboards, monitors, webhooks) depend on Query alone.
type Query interface {
	// Get returns the current state of a Task by ID.
	Get(ctx context.Context, id TaskID) (Task, error)

	// List returns Tasks matching the given state filter.
	// If no filter is provided, all Tasks are returned.
	List(ctx context.Context, filter ...State) ([]Task, error)
}
