package substrate

import (
	"context"

	"github.com/LangSensei/emploke/session/headless"
)

// Compile-time check: ensure the Runtime interface remains stable.
// Any change to verb signatures will fail compilation here.
//
// We do not provide a concrete substrate.Runtime; this is purely a
// signature contract. Implementations live in substrate/<name> packages.
var _ Runtime = (*nilRuntime)(nil)

// nilRuntime is a do-nothing Runtime used only for compile-time checks
// to ensure that this file demonstrates the contract.
type nilRuntime struct{}

func (nilRuntime) Dispatch(context.Context, headless.Task) error { return nil }
func (nilRuntime) Pause(context.Context, headless.TaskID) error  { return nil }
func (nilRuntime) Resume(context.Context, headless.TaskID, *headless.Supplement) error {
	return nil
}
func (nilRuntime) Kill(context.Context, headless.TaskID) error                      { return nil }
func (nilRuntime) Complete(context.Context, headless.TaskID, headless.Result) error { return nil }
func (nilRuntime) Fail(context.Context, headless.TaskID, headless.Failure) error    { return nil }
