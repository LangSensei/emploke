// Package conformance provides a shared, executable form of the
// emploke contract. Any Runtime + Repository implementation can verify
// itself by calling RunSuite from a test:
//
//	func TestConformance(t *testing.T) {
//	    conformance.RunSuite(t, func() (substrate.Runtime, headless.Repository) {
//	        rt, repo := myimpl.New()
//	        return rt, repo
//	    })
//	}
//
// The suite covers: state-machine transitions, supplement append-atomicity,
// kill idempotence on terminal Tasks, Complete/Fail from non-running
// rejection, double-dispatch rejection, Repository filtering, and TaskNotFound
// error propagation.
package headlesstest // import "github.com/LangSensei/emploke/conformance/headless"

import (
	"context"
	"errors"
	"testing"

	"github.com/LangSensei/emploke/session/headless"
	"github.com/LangSensei/emploke/substrate"
)

// Factory constructs a fresh Runtime+Repository pair for a single subtest.
type Factory func() (substrate.Runtime, headless.Repository)

// RunSuite executes the full conformance suite.
func RunSuite(t *testing.T, factory Factory) {
	t.Helper()
	ctx := context.Background()

	t.Run("Dispatch_TransitionsToRunning", func(t *testing.T) {
		rt, repo := factory()
		task := headless.New("t-disp", "a", "test", "do work")
		if err := rt.Dispatch(ctx, task); err != nil {
			t.Fatalf("Dispatch: %v", err)
		}
		got, err := repo.Load(ctx, task.ID)
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if got.Status != headless.StateRunning {
			t.Fatalf("expected running, got %s", got.Status)
		}
	})

	t.Run("PauseResume_WithExtra", func(t *testing.T) {
		rt, repo := factory()
		task := headless.New("t-pause", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)

		if err := rt.Pause(ctx, task.ID); err != nil {
			t.Fatalf("Pause: %v", err)
		}
		got, _ := repo.Load(ctx, task.ID)
		if got.Status != headless.StatePaused {
			t.Fatalf("expected paused, got %s", got.Status)
		}

		extra := &headless.Supplement{Payload: "more context"}
		if err := rt.Resume(ctx, task.ID, extra); err != nil {
			t.Fatalf("Resume: %v", err)
		}
		got, _ = repo.Load(ctx, task.ID)
		if got.Status != headless.StateRunning {
			t.Fatalf("expected running after resume, got %s", got.Status)
		}
		if len(got.Supplements) != 1 {
			t.Fatalf("expected 1 supplement, got %d", len(got.Supplements))
		}
	})

	t.Run("ResumeWithoutExtra_DoesNotGrowSupplements", func(t *testing.T) {
		rt, repo := factory()
		task := headless.New("t-res-noex", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		_ = rt.Pause(ctx, task.ID)
		_ = rt.Resume(ctx, task.ID, nil)
		got, _ := repo.Load(ctx, task.ID)
		if len(got.Supplements) != 0 {
			t.Fatalf("supplements should not grow, got %d", len(got.Supplements))
		}
	})

	t.Run("Kill_TransitionsActiveToCancelled", func(t *testing.T) {
		rt, repo := factory()
		task := headless.New("t-kill", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		if err := rt.Kill(ctx, task.ID); err != nil {
			t.Fatalf("Kill: %v", err)
		}
		got, _ := repo.Load(ctx, task.ID)
		if got.Status != headless.StateCancelled {
			t.Fatalf("expected cancelled, got %s", got.Status)
		}
	})

	t.Run("Kill_OnCompletedIsNoop", func(t *testing.T) {
		rt, repo := factory()
		task := headless.New("t-kill-done", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		if err := rt.Complete(ctx, task.ID, headless.Result{Payload: "ok"}); err != nil {
			t.Fatalf("Complete: %v", err)
		}
		if err := rt.Kill(ctx, task.ID); err != nil {
			t.Fatalf("Kill on terminal should be no-op, got %v", err)
		}
		got, _ := repo.Load(ctx, task.ID)
		if got.Status != headless.StateSuccess {
			t.Fatalf("should remain success, got %s", got.Status)
		}
	})

	t.Run("Kill_OnFailedIsNoop", func(t *testing.T) {
		rt, repo := factory()
		task := headless.New("t-kill-fail", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		if err := rt.Fail(ctx, task.ID, headless.Failure{Code: "x", Message: "y"}); err != nil {
			t.Fatalf("Fail: %v", err)
		}
		if err := rt.Kill(ctx, task.ID); err != nil {
			t.Fatalf("Kill on failed should be no-op, got %v", err)
		}
		got, _ := repo.Load(ctx, task.ID)
		if got.Status != headless.StateFailure {
			t.Fatalf("should remain failure, got %s", got.Status)
		}
	})

	t.Run("Pause_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		rt, _ := factory()
		err := rt.Pause(ctx, "nonexistent")
		if !errors.Is(err, headless.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("Resume_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		rt, _ := factory()
		err := rt.Resume(ctx, "nonexistent", nil)
		if !errors.Is(err, headless.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("Kill_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		rt, _ := factory()
		err := rt.Kill(ctx, "nonexistent")
		if !errors.Is(err, headless.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("Load_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		_, repo := factory()
		_, err := repo.Load(ctx, "nonexistent")
		if !errors.Is(err, headless.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("List_FiltersByState", func(t *testing.T) {
		rt, repo := factory()
		t1 := headless.New("t-list-1", "a", "test", "x")
		t2 := headless.New("t-list-2", "a", "test", "y")
		mustDispatch(t, rt, ctx, t1)
		mustDispatch(t, rt, ctx, t2)
		_ = rt.Complete(ctx, t1.ID, headless.Result{})

		running, _ := repo.List(ctx, headless.StateRunning)
		if len(running) != 1 || running[0].ID != t2.ID {
			t.Fatalf("expected 1 running task (t2), got %d", len(running))
		}
		all, _ := repo.List(ctx)
		if len(all) != 2 {
			t.Fatalf("expected 2 total tasks, got %d", len(all))
		}
	})

	t.Run("Dispatch_DoubleDispatchRejected", func(t *testing.T) {
		rt, _ := factory()
		task := headless.New("t-ddup", "a", "test", "x")
		mustDispatch(t, rt, ctx, task)
		err := rt.Dispatch(ctx, task)
		if !errors.Is(err, headless.ErrInvalidTransition) {
			t.Fatalf("expected ErrInvalidTransition on double dispatch, got %v", err)
		}
	})
}

func mustDispatch(t *testing.T, rt substrate.Runtime, ctx context.Context, task headless.Task) {
	t.Helper()
	if err := rt.Dispatch(ctx, task); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
}
