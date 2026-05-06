package task

// Result is the structured value carried in Task.Result when a Task ends in
// StateSuccess. Its shape is impl-defined; the kernel only guarantees that
// it is set atomically with the success transition.
type Result struct {
	Payload  any
	Metadata map[string]any
}
