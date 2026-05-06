package copilot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	agentfs "github.com/LangSensei/emploke/agent/fs"
	"github.com/LangSensei/emploke/task"
)

// Runtime implements [task.Runtime] for the Copilot CLI substrate.
type Runtime struct {
	repo     task.Repository
	registry *agentfs.Registry
	baseDir  string
}

// NewRuntime creates a Runtime from the given Config.
func NewRuntime(cfg Config) *Runtime {
	baseDir := cfg.BaseDir
	if baseDir == "" {
		home, _ := os.UserHomeDir()
		baseDir = filepath.Join(home, ".copilot", "tasks")
	}
	return &Runtime{
		repo:     cfg.Repo,
		registry: cfg.Registry,
		baseDir:  baseDir,
	}
}

func (r *Runtime) Dispatch(ctx context.Context, t task.Task) error {
	ag, err := r.registry.GetAgent(ctx, t.AgentName)
	if err != nil {
		return fmt.Errorf("copilot: agent %q: %w", t.AgentName, err)
	}

	workdir, err := r.provision(ctx, t, ag)
	if err != nil {
		_ = cleanup(r.baseDir, t.ID)
		return fmt.Errorf("copilot: provision: %w", err)
	}

	dispatched, err := task.Apply(t, task.Dispatched{})
	if err != nil {
		_ = cleanup(r.baseDir, t.ID)
		return fmt.Errorf("copilot: apply dispatched: %w", err)
	}

	sessionID, pid, err := startProcess(workdir, t.Instructions)
	if err != nil {
		_ = cleanup(r.baseDir, t.ID)
		return fmt.Errorf("copilot: %w", err)
	}

	if dispatched.Metadata == nil {
		dispatched.Metadata = make(map[string]any)
	}
	dispatched.Metadata["copilot.session_id"] = sessionID
	dispatched.Metadata["copilot.workdir"] = workdir
	dispatched.Metadata["copilot.pid"] = pid

	if err := r.repo.Save(ctx, dispatched); err != nil {
		killProcess(pid)
		_ = cleanup(r.baseDir, t.ID)
		return fmt.Errorf("copilot: save: %w", err)
	}

	return nil
}

func (r *Runtime) Pause(ctx context.Context, id task.TaskID) error {
	loaded, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	killProcess(metaPID(loaded))

	paused, err := task.Apply(loaded, task.Paused{})
	if err != nil {
		return err
	}
	return r.repo.Save(ctx, paused)
}

func (r *Runtime) Resume(ctx context.Context, id task.TaskID, extra *task.Supplement) error {
	loaded, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	resumed, err := task.Apply(loaded, task.Resumed{Extra: extra})
	if err != nil {
		return err
	}

	sessionID, _ := loaded.Metadata["copilot.session_id"].(string)
	workdir, _ := loaded.Metadata["copilot.workdir"].(string)
	prompt := loaded.Instructions
	if extra != nil && extra.Payload != nil {
		if s, ok := extra.Payload.(string); ok {
			prompt = s
		}
	}

	pid, err := resumeProcess(sessionID, workdir, prompt)
	if err != nil {
		return fmt.Errorf("copilot: %w", err)
	}

	if resumed.Metadata == nil {
		resumed.Metadata = make(map[string]any)
	}
	resumed.Metadata["copilot.pid"] = pid

	return r.repo.Save(ctx, resumed)
}

func (r *Runtime) Kill(ctx context.Context, id task.TaskID) error {
	loaded, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	killProcess(metaPID(loaded))

	cancelled, err := task.Apply(loaded, task.Cancelled{})
	if err != nil {
		return err
	}

	_ = cleanup(r.baseDir, id)
	return r.repo.Save(ctx, cancelled)
}

func (r *Runtime) Complete(ctx context.Context, id task.TaskID, result task.Result) error {
	loaded, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}
	completed, err := task.Apply(loaded, task.Completed{Result: result})
	if err != nil {
		return err
	}
	return r.repo.Save(ctx, completed)
}

func (r *Runtime) Fail(ctx context.Context, id task.TaskID, failure task.Failure) error {
	loaded, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}
	failed, err := task.Apply(loaded, task.Failed{Failure: failure})
	if err != nil {
		return err
	}
	return r.repo.Save(ctx, failed)
}

// metaPID extracts PID from task metadata.
func metaPID(t task.Task) int {
	if t.Metadata == nil {
		return 0
	}
	switch v := t.Metadata["copilot.pid"].(type) {
	case int:
		return v
	case float64:
		return int(v)
	}
	return 0
}
