package task

import "fmt"

// Apply is the single entry point for all Task state transitions.
//
// It is a pure function: given the current Task and an Event, it returns
// the next Task state or an error if the transition is illegal. Apply has
// no side effects — no I/O, no locks, no time calls (timestamps come from
// the Event).
func Apply(t Task, e Event) (Task, error) {
	switch ev := e.(type) {
	case Dispatched:
		if t.Status != StateNotStarted {
			return t, ErrInvalidTransition
		}
		t.Status = StateRunning
		t.StartedAt = &ev.At
		return t, nil

	case Paused:
		if t.Status != StateRunning {
			return t, ErrInvalidTransition
		}
		t.Status = StatePaused
		return t, nil

	case Resumed:
		if t.Status != StatePaused {
			return t, ErrInvalidTransition
		}
		t.Status = StateRunning
		if ev.Extra != nil {
			t.Supplements = append(cloneSupplements(t.Supplements), *ev.Extra)
		}
		return t, nil

	case Completed:
		if t.Status != StateRunning {
			return t, ErrInvalidTransition
		}
		t.Status = StateSuccess
		t.Result = &ev.Result
		t.EndedAt = &ev.At
		return t, nil

	case Failed:
		if t.Status != StateRunning {
			return t, ErrInvalidTransition
		}
		t.Status = StateFailure
		t.Failure = &ev.Failure
		t.EndedAt = &ev.At
		return t, nil

	case Cancelled:
		if t.Status.IsTerminal() {
			return t, nil // idempotent on terminal
		}
		t.Status = StateCancelled
		t.EndedAt = &ev.At
		return t, nil

	default:
		return t, fmt.Errorf("kernel: unknown event type %T", e)
	}
}

func cloneSupplements(s []Supplement) []Supplement {
	if s == nil {
		return nil
	}
	out := make([]Supplement, len(s))
	copy(out, s)
	return out
}
