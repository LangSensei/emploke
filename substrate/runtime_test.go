package substrate_test

import (
	"context"
	"testing"

	"github.com/LangSensei/emploke/session/headless"
	"github.com/LangSensei/emploke/substrate"
)

// stubRuntime confirms that an external impl can satisfy the Runtime
// interface using just the headless package types — i.e. the contract
// is consumable by package-external code.
type stubRuntime struct{}

func (stubRuntime) Dispatch(context.Context, headless.Task) error { return nil }
func (stubRuntime) Pause(context.Context, headless.TaskID) error  { return nil }
func (stubRuntime) Resume(context.Context, headless.TaskID, *headless.Supplement) error {
	return nil
}
func (stubRuntime) Kill(context.Context, headless.TaskID) error                      { return nil }
func (stubRuntime) Complete(context.Context, headless.TaskID, headless.Result) error { return nil }
func (stubRuntime) Fail(context.Context, headless.TaskID, headless.Failure) error    { return nil }

func TestRuntimeInterfaceStable(t *testing.T) {
	var _ substrate.Runtime = stubRuntime{}
}
