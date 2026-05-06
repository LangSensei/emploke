// Package tasktest provides a shared, executable form of the emploke contract.
// Any Runtime + Repository implementation can verify itself by calling RunSuite.
package tasktest

import (
	"context"
	"errors"
	"testing"

	"github.com/LangSensei/emploke/task"
)

// Factory constructs a fresh Runtime+Repository pair for a single subtest.
type Factory func() (*Runtime, *Repository)

// RunSuite executes the full conformance suite.
func RunSuite(t *testing.T, factory Factory) {
	t.Helper()
	ctx := context.Background()

	t.Run("Dispatch_TransitionsToRunning", func(t *testing.T) {
		rt, repo := factory()
		tk := task.New("t-disp", "a", "test", "do work")
		if err := rt.Dispatch(ctx, tk); err != nil {
			t.Fatalf("Dispatch: %v", err)
		}
		got, err := repo.Load(ctx, tk.ID)
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if got.Status != task.StateRunning {
			t.Fatalf("expected running, got %s", got.Status)
		}
	})

	t.Run("PauseResume_WithExtra", func(t *testing.T) {
		rt, repo := factory()
		tk := task.New("t-pause", "a", "test", "x")
		mustDispatch(t, rt, ctx, tk)

		if err := rt.Pause(ctx, tk.ID); err != nil {
			t.Fatalf("Pause: %v", err)
		}
		got, _ := repo.Load(ctx, tk.ID)
		if got.Status != task.StatePaused {
			t.Fatalf("expected paused, got %s", got.Status)
		}

		extra := &task.Supplement{Payload: "more context"}
		if err := rt.Resume(ctx, tk.ID, extra); err != nil {
			t.Fatalf("Resume: %v", err)
		}
		got, _ = repo.Load(ctx, tk.ID)
		if got.Status != task.StateRunning {
			t.Fatalf("expected running after resume, got %s", got.Status)
		}
		if len(got.Supplements) != 1 {
			t.Fatalf("expected 1 supplement, got %d", len(got.Supplements))
		}
	})

	t.Run("ResumeWithoutExtra_DoesNotGrowSupplements", func(t *testing.T) {
		rt, repo := factory()
		tk := task.New("t-res-noex", "a", "test", "x")
		mustDispatch(t, rt, ctx, tk)
		_ = rt.Pause(ctx, tk.ID)
		_ = rt.Resume(ctx, tk.ID, nil)
		got, _ := repo.Load(ctx, tk.ID)
		if len(got.Supplements) != 0 {
			t.Fatalf("supplements should not grow, got %d", len(got.Supplements))
		}
	})

	t.Run("Kill_TransitionsActiveToCancelled", func(t *testing.T) {
		rt, repo := factory()
		tk := task.New("t-kill", "a", "test", "x")
		mustDispatch(t, rt, ctx, tk)
		if err := rt.Kill(ctx, tk.ID); err != nil {
			t.Fatalf("Kill: %v", err)
		}
		got, _ := repo.Load(ctx, tk.ID)
		if got.Status != task.StateCancelled {
			t.Fatalf("expected cancelled, got %s", got.Status)
		}
	})

	t.Run("Kill_OnCompletedIsNoop", func(t *testing.T) {
		rt, repo := factory()
		tk := task.New("t-kill-done", "a", "test", "x")
		mustDispatch(t, rt, ctx, tk)
		if err := rt.Complete(ctx, tk.ID, task.Result{Payload: "ok"}); err != nil {
			t.Fatalf("Complete: %v", err)
		}
		if err := rt.Kill(ctx, tk.ID); err != nil {
			t.Fatalf("Kill on terminal should be no-op, got %v", err)
		}
		got, _ := repo.Load(ctx, tk.ID)
		if got.Status != task.StateSuccess {
			t.Fatalf("should remain success, got %s", got.Status)
		}
	})

	t.Run("Kill_OnFailedIsNoop", func(t *testing.T) {
		rt, repo := factory()
		tk := task.New("t-kill-fail", "a", "test", "x")
		mustDispatch(t, rt, ctx, tk)
		if err := rt.Fail(ctx, tk.ID, task.Failure{Code: "x", Message: "y"}); err != nil {
			t.Fatalf("Fail: %v", err)
		}
		if err := rt.Kill(ctx, tk.ID); err != nil {
			t.Fatalf("Kill on failed should be no-op, got %v", err)
		}
		got, _ := repo.Load(ctx, tk.ID)
		if got.Status != task.StateFailure {
			t.Fatalf("should remain failure, got %s", got.Status)
		}
	})

	t.Run("Pause_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		rt, _ := factory()
		err := rt.Pause(ctx, "nonexistent")
		if !errors.Is(err, task.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("Resume_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		rt, _ := factory()
		err := rt.Resume(ctx, "nonexistent", nil)
		if !errors.Is(err, task.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("Kill_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		rt, _ := factory()
		err := rt.Kill(ctx, "nonexistent")
		if !errors.Is(err, task.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("Load_OnUnknownReturnsTaskNotFound", func(t *testing.T) {
		_, repo := factory()
		_, err := repo.Load(ctx, "nonexistent")
		if !errors.Is(err, task.ErrTaskNotFound) {
			t.Fatalf("expected ErrTaskNotFound, got %v", err)
		}
	})

	t.Run("List_FiltersByState", func(t *testing.T) {
		rt, repo := factory()
		t1 := task.New("t-list-1", "a", "test", "x")
		t2 := task.New("t-list-2", "a", "test", "y")
		mustDispatch(t, rt, ctx, t1)
		mustDispatch(t, rt, ctx, t2)
		_ = rt.Complete(ctx, t1.ID, task.Result{})

		running, _ := repo.List(ctx, task.StateRunning)
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
		tk := task.New("t-ddup", "a", "test", "x")
		mustDispatch(t, rt, ctx, tk)
		err := rt.Dispatch(ctx, tk)
		if !errors.Is(err, task.ErrInvalidTransition) {
			t.Fatalf("expected ErrInvalidTransition on double dispatch, got %v", err)
		}
	})
}

func mustDispatch(t *testing.T, rt *Runtime, ctx context.Context, tk task.Task) {
	t.Helper()
	if err := rt.Dispatch(ctx, tk); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
}
