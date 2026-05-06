package task

import "context"

// Repository persists and retrieves Task aggregates.
//
// Repository is the single interface for task storage and lookup. It replaces
// the need for a separate Query interface — callers read tasks directly from
// the repository.
//
// Save is idempotent: saving a Task with the same ID replaces the previous
// version. Delete is idempotent: deleting a non-existent Task returns nil.
type Repository interface {
	// Save persists the current state of a Task.
	Save(ctx context.Context, task Task) error

	// Load retrieves a Task by its ID.
	// Returns ErrTaskNotFound if the Task does not exist.
	Load(ctx context.Context, id TaskID) (Task, error)

	// List returns all persisted Tasks, optionally filtered by state.
	List(ctx context.Context, filter ...State) ([]Task, error)

	// Delete removes a Task from storage.
	Delete(ctx context.Context, id TaskID) error
}
