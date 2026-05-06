package copilot

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/LangSensei/emploke/catalog"
	"github.com/LangSensei/emploke/session/headless"
)

// --- in-memory test doubles -------------------------------------------------

type memRepo struct {
	mu    sync.Mutex
	tasks map[headless.TaskID]headless.Task
}

func newMemRepo() *memRepo { return &memRepo{tasks: map[headless.TaskID]headless.Task{}} }

func (m *memRepo) Save(_ context.Context, t headless.Task) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tasks[t.ID] = t
	return nil
}

func (m *memRepo) Load(_ context.Context, id headless.TaskID) (headless.Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[id]
	if !ok {
		return headless.Task{}, headless.ErrTaskNotFound
	}
	return t, nil
}

func (m *memRepo) List(_ context.Context, filter ...headless.State) ([]headless.Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []headless.Task
	for _, t := range m.tasks {
		if len(filter) == 0 {
			out = append(out, t)
			continue
		}
		for _, s := range filter {
			if t.Status == s {
				out = append(out, t)
				break
			}
		}
	}
	return out, nil
}

func (m *memRepo) Delete(_ context.Context, id headless.TaskID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.tasks, id)
	return nil
}

type memAgents struct {
	agents map[string]catalog.Agent
}

func (m *memAgents) GetAgent(_ context.Context, name string) (catalog.Agent, error) {
	if a, ok := m.agents[name]; ok {
		return a, nil
	}
	return catalog.Agent{}, errors.New("agent not found")
}

func (m *memAgents) ListAgents(_ context.Context) ([]catalog.Agent, error) {
	out := make([]catalog.Agent, 0, len(m.agents))
	for _, a := range m.agents {
		out = append(out, a)
	}
	return out, nil
}

func (m *memAgents) RegisterAgent(_ context.Context, a catalog.Agent) error {
	if m.agents == nil {
		m.agents = map[string]catalog.Agent{}
	}
	m.agents[a.Name] = a
	return nil
}

func (m *memAgents) RemoveAgent(_ context.Context, name string) error {
	delete(m.agents, name)
	return nil
}

type memResolver struct {
	caps map[string][]catalog.Capability
	err  error
}

func (m *memResolver) Resolve(_ context.Context, a catalog.Agent) ([]catalog.Capability, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.caps[a.Name], nil
}

func (m *memResolver) Missing(_ context.Context, _ catalog.Agent) ([]string, error) { return nil, nil }
func (m *memResolver) Dependents(_ context.Context, _ string) ([]catalog.Agent, error) {
	return nil, nil
}
func (m *memResolver) Orphans(_ context.Context) ([]catalog.Capability, error) { return nil, nil }

// --- builder helpers --------------------------------------------------------

type fakeOps struct {
	startCalls     int
	resumeCalls    int
	killCalls      int
	provisionCalls int
	cleanupCalls   int

	startSessionID string
	startPID       int
	startErr       error
	resumePID      int
	resumeErr      error
	provisionDir   string
	provisionErr   error

	lastStartPrompt   string
	lastResumePrompt  string
	lastKillPID       int
	lastResumeSession string
}

func newRuntime(t *testing.T, agent catalog.Agent, repo *memRepo) (*Runtime, *fakeOps) {
	t.Helper()
	ops := &fakeOps{
		startSessionID: "sess-1",
		startPID:       1234,
		resumePID:      5678,
		provisionDir:   "/tmp/fake-workdir",
	}
	agents := &memAgents{}
	_ = agents.RegisterAgent(context.Background(), agent)
	resolver := &memResolver{}

	rt := &Runtime{
		repo:     repo,
		agents:   agents,
		resolver: resolver,
		baseDir:  "/tmp/test-base",
		startProcess: func(workdir, prompt string) (string, int, error) {
			ops.startCalls++
			ops.lastStartPrompt = prompt
			return ops.startSessionID, ops.startPID, ops.startErr
		},
		resumeProcess: func(sessionID, workdir, prompt string) (int, error) {
			ops.resumeCalls++
			ops.lastResumePrompt = prompt
			ops.lastResumeSession = sessionID
			return ops.resumePID, ops.resumeErr
		},
		killProcess: func(pid int) {
			ops.killCalls++
			ops.lastKillPID = pid
		},
		provision: func(_ string, _ headless.Task, _ catalog.Agent, _ []catalog.Capability) (string, error) {
			ops.provisionCalls++
			return ops.provisionDir, ops.provisionErr
		},
		cleanup: func(_ string, _ headless.TaskID) error {
			ops.cleanupCalls++
			return nil
		},
	}
	return rt, ops
}

// --- Tests ------------------------------------------------------------------

func TestDispatch_HappyPath(t *testing.T) {
	repo := newMemRepo()
	agent := catalog.Agent{Name: "reviewer"}
	rt, ops := newRuntime(t, agent, repo)

	task := headless.New("t1", "reviewer", "copilot", "do the thing")
	if err := rt.Dispatch(context.Background(), task); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}

	if ops.provisionCalls != 1 {
		t.Errorf("provision calls: got %d, want 1", ops.provisionCalls)
	}
	if ops.startCalls != 1 {
		t.Errorf("start calls: got %d, want 1", ops.startCalls)
	}
	if ops.lastStartPrompt != "do the thing" {
		t.Errorf("start prompt: got %q", ops.lastStartPrompt)
	}

	saved, err := repo.Load(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Status != headless.StateRunning {
		t.Errorf("status: got %v, want running", saved.Status)
	}
	if saved.Metadata["copilot.session_id"] != "sess-1" {
		t.Errorf("session_id: got %v", saved.Metadata["copilot.session_id"])
	}
	if saved.Metadata["copilot.pid"] != 1234 {
		t.Errorf("pid: got %v", saved.Metadata["copilot.pid"])
	}
}

func TestDispatch_AgentNotFound(t *testing.T) {
	repo := newMemRepo()
	rt, ops := newRuntime(t, catalog.Agent{Name: "reviewer"}, repo)

	task := headless.New("t1", "missing", "copilot", "x")
	err := rt.Dispatch(context.Background(), task)
	if err == nil {
		t.Fatal("expected error for missing agent")
	}
	if ops.provisionCalls != 0 || ops.startCalls != 0 {
		t.Error("should not provision or start when agent missing")
	}
}

func TestDispatch_ProvisionError_NoStart(t *testing.T) {
	repo := newMemRepo()
	rt, ops := newRuntime(t, catalog.Agent{Name: "a"}, repo)
	ops.provisionErr = errors.New("disk full")

	err := rt.Dispatch(context.Background(), headless.New("t1", "a", "copilot", "x"))
	if err == nil {
		t.Fatal("expected provision error")
	}
	if ops.startCalls != 0 {
		t.Errorf("should not start when provision fails")
	}
}

func TestDispatch_StartError_TriggersCleanup(t *testing.T) {
	repo := newMemRepo()
	rt, ops := newRuntime(t, catalog.Agent{Name: "a"}, repo)
	ops.startErr = errors.New("copilot binary missing")

	err := rt.Dispatch(context.Background(), headless.New("t1", "a", "copilot", "x"))
	if err == nil {
		t.Fatal("expected start error")
	}
	if ops.cleanupCalls != 1 {
		t.Errorf("cleanup should be called once on start failure, got %d", ops.cleanupCalls)
	}
}

func TestPause_KillsProcessAndUpdatesState(t *testing.T) {
	repo := newMemRepo()
	rt, ops := newRuntime(t, catalog.Agent{Name: "a"}, repo)

	task := headless.New("t1", "a", "copilot", "x")
	_ = rt.Dispatch(context.Background(), task)
	ops.killCalls = 0 // reset

	if err := rt.Pause(context.Background(), task.ID); err != nil {
		t.Fatal(err)
	}
	if ops.killCalls != 1 {
		t.Errorf("kill calls: got %d, want 1", ops.killCalls)
	}
	if ops.lastKillPID != 1234 {
		t.Errorf("kill pid: got %d, want 1234", ops.lastKillPID)
	}
	saved, _ := repo.Load(context.Background(), task.ID)
	if saved.Status != headless.StatePaused {
		t.Errorf("status: got %v, want paused", saved.Status)
	}
}

func TestResume_RestartsProcessWithSessionID(t *testing.T) {
	repo := newMemRepo()
	rt, ops := newRuntime(t, catalog.Agent{Name: "a"}, repo)

	task := headless.New("t1", "a", "copilot", "x")
	_ = rt.Dispatch(context.Background(), task)
	_ = rt.Pause(context.Background(), task.ID)

	if err := rt.Resume(context.Background(), task.ID, nil); err != nil {
		t.Fatal(err)
	}
	if ops.resumeCalls != 1 {
		t.Errorf("resume calls: got %d, want 1", ops.resumeCalls)
	}
	if ops.lastResumeSession != "sess-1" {
		t.Errorf("resume session id: got %q", ops.lastResumeSession)
	}

	saved, _ := repo.Load(context.Background(), task.ID)
	if saved.Status != headless.StateRunning {
		t.Errorf("status: got %v, want running", saved.Status)
	}
}

func TestResume_WithSupplement_OverridesPrompt(t *testing.T) {
	repo := newMemRepo()
	rt, ops := newRuntime(t, catalog.Agent{Name: "a"}, repo)

	task := headless.New("t1", "a", "copilot", "original")
	_ = rt.Dispatch(context.Background(), task)
	_ = rt.Pause(context.Background(), task.ID)

	supp := &headless.Supplement{Payload: "new prompt"}
	if err := rt.Resume(context.Background(), task.ID, supp); err != nil {
		t.Fatal(err)
	}
	if ops.lastResumePrompt != "new prompt" {
		t.Errorf("supplement payload should override prompt; got %q", ops.lastResumePrompt)
	}
}

func TestKill_TransitionsToCancelledAndCleansUp(t *testing.T) {
	repo := newMemRepo()
	rt, ops := newRuntime(t, catalog.Agent{Name: "a"}, repo)

	task := headless.New("t1", "a", "copilot", "x")
	_ = rt.Dispatch(context.Background(), task)
	ops.killCalls = 0
	ops.cleanupCalls = 0

	if err := rt.Kill(context.Background(), task.ID); err != nil {
		t.Fatal(err)
	}
	if ops.killCalls != 1 {
		t.Errorf("kill calls: got %d, want 1", ops.killCalls)
	}
	if ops.cleanupCalls != 1 {
		t.Errorf("cleanup calls: got %d, want 1", ops.cleanupCalls)
	}
	saved, _ := repo.Load(context.Background(), task.ID)
	if saved.Status != headless.StateCancelled {
		t.Errorf("status: got %v, want cancelled", saved.Status)
	}
}

func TestComplete_TransitionsToSuccess(t *testing.T) {
	repo := newMemRepo()
	rt, _ := newRuntime(t, catalog.Agent{Name: "a"}, repo)

	task := headless.New("t1", "a", "copilot", "x")
	_ = rt.Dispatch(context.Background(), task)

	res := headless.Result{Payload: "done"}
	if err := rt.Complete(context.Background(), task.ID, res); err != nil {
		t.Fatal(err)
	}
	saved, _ := repo.Load(context.Background(), task.ID)
	if saved.Status != headless.StateSuccess {
		t.Errorf("status: got %v, want success", saved.Status)
	}
	if saved.Result == nil || saved.Result.Payload != "done" {
		t.Errorf("result not set correctly: %+v", saved.Result)
	}
}

func TestFail_TransitionsToFailure(t *testing.T) {
	repo := newMemRepo()
	rt, _ := newRuntime(t, catalog.Agent{Name: "a"}, repo)

	task := headless.New("t1", "a", "copilot", "x")
	_ = rt.Dispatch(context.Background(), task)

	f := headless.Failure{Code: "agent/timeout", Message: "too slow"}
	if err := rt.Fail(context.Background(), task.ID, f); err != nil {
		t.Fatal(err)
	}
	saved, _ := repo.Load(context.Background(), task.ID)
	if saved.Status != headless.StateFailure {
		t.Errorf("status: got %v, want failure", saved.Status)
	}
	if saved.Failure == nil || saved.Failure.Code != "agent/timeout" {
		t.Errorf("failure not set correctly: %+v", saved.Failure)
	}
}

func TestPause_TaskNotFound(t *testing.T) {
	repo := newMemRepo()
	rt, _ := newRuntime(t, catalog.Agent{Name: "a"}, repo)

	err := rt.Pause(context.Background(), headless.TaskID("nonexistent"))
	if err == nil {
		t.Fatal("expected ErrTaskNotFound")
	}
}

func TestKill_OnTerminalTask_NoOp(t *testing.T) {
	repo := newMemRepo()
	rt, ops := newRuntime(t, catalog.Agent{Name: "a"}, repo)

	task := headless.New("t1", "a", "copilot", "x")
	_ = rt.Dispatch(context.Background(), task)
	_ = rt.Complete(context.Background(), task.ID, headless.Result{})
	ops.killCalls = 0
	ops.cleanupCalls = 0

	// Apply Cancelled on terminal is idempotent (no transition error)
	if err := rt.Kill(context.Background(), task.ID); err != nil {
		t.Fatalf("Kill on terminal should be idempotent, got: %v", err)
	}
	saved, _ := repo.Load(context.Background(), task.ID)
	if saved.Status != headless.StateSuccess {
		t.Errorf("terminal task should stay terminal; got %v", saved.Status)
	}
}
