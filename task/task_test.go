package task

import (
	"errors"
	"testing"
	"time"
)

func TestNew_IsNotStarted(t *testing.T) {
	task := New("t1", "agent-1", "inmemory", "do the thing")
	if task.Status != StateNotStarted {
		t.Fatalf("expected not_started, got %s", task.Status)
	}
	if task.StartedAt != nil || task.EndedAt != nil {
		t.Fatalf("times should be nil on a fresh Task")
	}
}

func TestApply_DispatchHappyPath(t *testing.T) {
	task := New("t1", "a", "im", "x")
	now := time.Now()
	next, err := Apply(task, Dispatched{At: now})
	mustNoErr(t, err)
	if next.Status != StateRunning {
		t.Fatalf("expected running, got %s", next.Status)
	}
	if next.StartedAt == nil || !next.StartedAt.Equal(now) {
		t.Fatalf("StartedAt not set correctly")
	}
}

func TestApply_CompleteHappyPath(t *testing.T) {
	task := New("t1", "a", "im", "x")
	now := time.Now()
	task, _ = Apply(task, Dispatched{At: now})
	task, err := Apply(task, Completed{At: now, Result: Result{Payload: "ok"}})
	mustNoErr(t, err)
	if task.Status != StateSuccess {
		t.Fatalf("expected success, got %s", task.Status)
	}
	if task.EndedAt == nil {
		t.Fatalf("EndedAt should be set")
	}
}

func TestApply_PauseResumeAppendsSupplementAtomically(t *testing.T) {
	now := time.Now()
	task := New("t2", "a", "im", "x")
	task, _ = Apply(task, Dispatched{At: now})
	task, _ = Apply(task, Paused{At: now})
	if len(task.Supplements) != 0 {
		t.Fatalf("expected 0 supplements before resume")
	}
	task, err := Apply(task, Resumed{At: now, Extra: &Supplement{At: now, Payload: "more"}})
	mustNoErr(t, err)
	if len(task.Supplements) != 1 {
		t.Fatalf("expected 1 supplement, got %d", len(task.Supplements))
	}
	if task.Status != StateRunning {
		t.Fatalf("expected running after resume, got %s", task.Status)
	}
}

func TestApply_ResumeWithoutExtra(t *testing.T) {
	now := time.Now()
	task := New("t3", "a", "im", "x")
	task, _ = Apply(task, Dispatched{At: now})
	task, _ = Apply(task, Paused{At: now})
	task, err := Apply(task, Resumed{At: now, Extra: nil})
	mustNoErr(t, err)
	if len(task.Supplements) != 0 {
		t.Fatalf("supplements should not grow on resume(nil)")
	}
}

func TestApply_CancelIdempotentOnTerminal(t *testing.T) {
	now := time.Now()
	task := New("t4", "a", "im", "x")
	task, _ = Apply(task, Dispatched{At: now})
	task, _ = Apply(task, Completed{At: now, Result: Result{}})
	task, err := Apply(task, Cancelled{At: now})
	mustNoErr(t, err)
	if task.Status != StateSuccess {
		t.Fatalf("should remain success, got %s", task.Status)
	}
}

func TestApply_CancelFromNotStarted(t *testing.T) {
	now := time.Now()
	task := New("t5", "a", "im", "x")
	task, err := Apply(task, Cancelled{At: now})
	mustNoErr(t, err)
	if task.Status != StateCancelled {
		t.Fatalf("expected cancelled, got %s", task.Status)
	}
}

func TestApply_CancelFromPaused(t *testing.T) {
	now := time.Now()
	task := New("t6", "a", "im", "x")
	task, _ = Apply(task, Dispatched{At: now})
	task, _ = Apply(task, Paused{At: now})
	task, err := Apply(task, Cancelled{At: now})
	mustNoErr(t, err)
	if task.Status != StateCancelled {
		t.Fatalf("expected cancelled, got %s", task.Status)
	}
}

func TestApply_DoubleDispatchRejected(t *testing.T) {
	now := time.Now()
	task := New("t7", "a", "im", "x")
	task, _ = Apply(task, Dispatched{At: now})
	_, err := Apply(task, Dispatched{At: now})
	if !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("expected ErrInvalidTransition, got %v", err)
	}
}

func TestApply_CompleteFromNonRunning(t *testing.T) {
	task := New("t8", "a", "im", "x")
	_, err := Apply(task, Completed{At: time.Now(), Result: Result{}})
	if !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("expected ErrInvalidTransition, got %v", err)
	}
}

func TestApply_FailFromNonRunning(t *testing.T) {
	task := New("t9", "a", "im", "x")
	_, err := Apply(task, Failed{At: time.Now(), Failure: Failure{Code: "x", Message: "y"}})
	if !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("expected ErrInvalidTransition, got %v", err)
	}
}

func TestApply_FailHappyPath(t *testing.T) {
	now := time.Now()
	task := New("t10", "a", "im", "x")
	task, _ = Apply(task, Dispatched{At: now})
	task, err := Apply(task, Failed{At: now, Failure: Failure{Code: "timeout", Message: "too slow"}})
	mustNoErr(t, err)
	if task.Status != StateFailure {
		t.Fatalf("expected failure, got %s", task.Status)
	}
	if task.Failure == nil || task.Failure.Code != "timeout" {
		t.Fatalf("failure not set correctly")
	}
}

func TestApply_CancelOnFailedIsNoop(t *testing.T) {
	now := time.Now()
	task := New("t11", "a", "im", "x")
	task, _ = Apply(task, Dispatched{At: now})
	task, _ = Apply(task, Failed{At: now, Failure: Failure{Code: "x", Message: "y"}})
	task, err := Apply(task, Cancelled{At: now})
	mustNoErr(t, err)
	if task.Status != StateFailure {
		t.Fatalf("should remain failure, got %s", task.Status)
	}
}

func TestApply_SupplementsAreNotShared(t *testing.T) {
	now := time.Now()
	task := New("t12", "a", "im", "x")
	task, _ = Apply(task, Dispatched{At: now})
	task, _ = Apply(task, Paused{At: now})
	task, _ = Apply(task, Resumed{At: now, Extra: &Supplement{At: now, Payload: "first"}})

	snapshot := task // value copy
	task, _ = Apply(task, Paused{At: now})
	task, _ = Apply(task, Resumed{At: now, Extra: &Supplement{At: now, Payload: "second"}})

	if len(snapshot.Supplements) != 1 {
		t.Fatalf("snapshot supplements mutated: got %d", len(snapshot.Supplements))
	}
	if len(task.Supplements) != 2 {
		t.Fatalf("task should have 2 supplements, got %d", len(task.Supplements))
	}
}

func TestState_IsTerminal(t *testing.T) {
	cases := map[State]bool{
		StateNotStarted: false, StateRunning: false, StatePaused: false,
		StateSuccess: true, StateFailure: true, StateCancelled: true,
	}
	for s, want := range cases {
		if got := s.IsTerminal(); got != want {
			t.Errorf("State(%s).IsTerminal() = %v, want %v", s, got, want)
		}
	}
}

func TestState_IsActive(t *testing.T) {
	cases := map[State]bool{
		StateNotStarted: false, StateRunning: true, StatePaused: true,
		StateSuccess: false, StateFailure: false, StateCancelled: false,
	}
	for s, want := range cases {
		if got := s.IsActive(); got != want {
			t.Errorf("State(%s).IsActive() = %v, want %v", s, got, want)
		}
	}
}

func mustNoErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
