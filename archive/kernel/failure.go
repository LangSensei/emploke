package kernel

// Failure is the structured value carried in Task.Failure when a Task ends
// in StateFailure.
//
// Code is impl-defined (suggested namespace "<impl>/<code>"). Both Code and
// Message are required.
//
// The kernel deliberately does NOT include a Retriable bool. Whether a given
// Code is retriable depends on the workflow's tolerance, budget, and context
// — not on the failure itself. Retry policy lives at the layer above as
// code → action; Failure stays opinion-free.
type Failure struct {
	Code     string
	Message  string
	Metadata map[string]any
}
