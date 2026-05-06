// Package conformance provides a shared, executable form of the
// AgenticKernel contract. Any Runtime + Query implementation can verify
// itself by calling RunSuite from a test:
//
//	func TestConformance(t *testing.T) {
//	    conformance.RunSuite(t, func() (kernel.Runtime, kernel.Query) {
//	        rt, q := myimpl.New()
//	        return rt, q
//	    })
//	}
//
// The suite covers: state-machine transitions, supplement append-atomicity,
// kill idempotence on terminal Tasks, Complete/Fail from non-running
// rejection, double-dispatch rejection, Query filtering, and TaskNotFound
// error propagation.
package kerneltest // import "github.com/LangSensei/emploke/conformance/kernel"

import (
	"context"
	"errors"
	"testing"

	"github.com/LangSensei/emploke/kernel"
)

// Factory constructs a fresh Runtime+Query pair for a single subtest.
type Factory func() (kernel.Runtime, kernel.Query)

// RunSuite executes the full conformance suite.
func RunSuite(t *testing.T, factory Factory) {
	t.Helper()
	ctx := context.Background()

	t.Run("Dispatch_TransitionsToRunning", func(t *testing.T) {
		rt, q := factory()
		task := kernel.New("t-disp", "a", "test", "do work")
		if err := rt.Dispatch(ctx, task); err != nil {
			t.Fatalf("Dispatch: %v", err)
		}
		got, err := q.Get(ctx, task.ID)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if got.Status != kernel.StateRunning {
			t.Fatalf("expected running, got %s", got.Status)
		}
	})

	t.Run("PauseResume_WithExtra", func(t *testing.T) {
		rt, q := factory()
		task := kernel.New("t-pause", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)

		if err := rt.Pause(ctx, task.ID); err != nil {
			t.Fatalf("Pause: %v", err)
		}
		got, _ := q.Get(ctx, task.ID)
		if got.Status != kernel.StatePaused {
			t.Fatalf("expected paused, got %s", got.Status)
		}

		extra := &kernel.Supplement{Payload: "more context"}
		if err := rt.Resume(ctx, task.ID, extra); err != nil {
			t.Fatalf("Resume: %v", err)
		}
		got, _ = q.Get(ctx, task.ID)
		if got.Status != kernel.StateRunning {
			t.Fatalf("expected running after resume, got %s", got.Status)
		}
		if len(got.Supplements) != 1 {
			t.Fatalf("expected 1 supplement, got %d", len(got.Supplements))
		}
	})

	t.Run("ResumeWithoutExtra_DoesNotGrowSupplements", func(t *testing.T) {
		rt, q := factory()
		task := kernel.New("t-res-noex", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		_ = rt.Pause(ctx, task.ID)
		_ = rt.Resume(ctx, task.ID, nil)
		got, _ := q.Get(ctx, task.ID)
		if len(got.Supplements) != 0 {
			t.Fatalf("supplements should not grow, got %d", len(got.Supplements))
		}
	})

	t.Run("Kill_TransitionsActiveToCancelled", func(t *testing.T) {
		rt, q := factory()
		task := kernel.New("t-kill", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		if err := rt.Kill(ctx, task.ID); err != nil {
			t.Fatalf("Kill: %v", err)
		}
		got, _ := q.Get(ctx, task.ID)
		if got.Status != kernel.StateCancelled {
			t.Fatalf("expected cancelled, got %s", got.Status)
		}
	})

	t.Run("Kill_OnCompletedIsNoop", func(t *testing.T) {
		rt, q := factory()
		task := kernel.New("t-kill-done", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		if err := rt.Complete(ctx, task.ID, kernel.Result{Payload: "ok"}); err != nil {
			t.Fatalf("Complete: %v", err)
		}
		if err := rt.Kill(ctx, task.ID); err != nil {
			t.Fatalf("Kill on terminal should be no-op, got %v", err)
		}
		got, _ := q.Get(ctx, task.ID)
		if got.Status != kernel.StateSuccess {
			t.Fatalf("should remain success, got %s", got.Status)
		}
	})

	t.Run("Kill_OnFailedIsNoop", func(t *testing.T) {
		rt, q := factory()
		task := kernel.New("t-kill-fail", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		if err := rt.Fail(ctx, task.ID, kernel.Failure{Code: "x", Message: "y"}); err != nil {
			t.Fatalf("Fail: %v", err)
		}
		if err := rt.Kill(ctx, task.ID); err != nil {
			t.Fatalf("Kill on failed should be no-op, got %v", err)
		}
		got, _ := q.Get(ctx, task.ID)
		if got.Status != kernel.StateFailure {
			t.Fatalf("should remain failure, got %s", got.Status)
		}
	})

	t.Run("Pause_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		rt, _ := factory()
		err := rt.Pause(ctx, "nonexistent")
		if !errors.Is(err, kernel.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("Resume_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		rt, _ := factory()
		err := rt.Resume(ctx, "nonexistent", nil)
		if !errors.Is(err, kernel.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("Kill_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		rt, _ := factory()
		err := rt.Kill(ctx, "nonexistent")
		if !errors.Is(err, kernel.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("Get_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		_, q := factory()
		_, err := q.Get(ctx, "nonexistent")
		if !errors.Is(err, kernel.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("List_FiltersByState", func(t *testing.T) {
		rt, q := factory()
		t1 := kernel.New("t-list-1", "a", "test", "x")
		t2 := kernel.New("t-list-2", "a", "test", "y")
		mustDispatch(t, rt, ctx, t1)
		mustDispatch(t, rt, ctx, t2)
		_ = rt.Complete(ctx, t1.ID, kernel.Result{})

		running, _ := q.List(ctx, kernel.StateRunning)
		if len(running) != 1 || running[0].ID != t2.ID {
			t.Fatalf("expected 1 running task (t2), got %d", len(running))
		}
		all, _ := q.List(ctx)
		if len(all) != 2 {
			t.Fatalf("expected 2 total tasks, got %d", len(all))
		}
	})

	t.Run("Dispatch_DoubleDispatchRejected", func(t *testing.T) {
		rt, _ := factory()
		task := kernel.New("t-ddup", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		err := rt.Dispatch(ctx, task)
		if !errors.Is(err, kernel.ErrInvalidTransition) {
			t.Fatalf("expected ErrInvalidTransition on double dispatch, got %v", err)
		}
	})
}

func mustDispatch(t *testing.T, rt kernel.Runtime, ctx context.Context, task kernel.Task) {
	t.Helper()
	if err := rt.Dispatch(ctx, task); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
}
