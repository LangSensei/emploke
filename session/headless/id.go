package headless

// TaskID is the unique handle for a Task.
//
// It is opaque to the kernel; impls and the layer above are free to choose
// the format (UUID, ULID, monotonic counter, etc.). The kernel does not
// generate, validate, or interpret TaskIDs.
type TaskID string
