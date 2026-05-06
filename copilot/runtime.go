package copilot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/LangSensei/emploke/kernel"
	"github.com/LangSensei/emploke/registry"
)

// Runtime implements [kernel.Runtime] for the Copilot CLI substrate.
type Runtime struct {
	repo     kernel.Repository
	agents   registry.AgentRegistry
	resolver registry.Resolver
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
		agents:   cfg.Agents,
		resolver: cfg.Resolver,
		baseDir:  baseDir,
	}
}

func (r *Runtime) Dispatch(ctx context.Context, task kernel.Task) error {
	agent, err := r.agents.GetAgent(ctx, task.AgentName)
	if err != nil {
		return fmt.Errorf("copilot: agent %q: %w", task.AgentName, err)
	}

	caps, err := r.resolver.Resolve(ctx, agent)
	if err != nil {
		return fmt.Errorf("copilot: resolve capabilities: %w", err)
	}

	workdir, err := provision(r.baseDir, task, agent, caps)
	if err != nil {
		return fmt.Errorf("copilot: provision: %w", err)
	}

	dispatched, err := kernel.Apply(task, kernel.Dispatched{})
	if err != nil {
		_ = cleanup(r.baseDir, task.ID)
		return fmt.Errorf("copilot: apply dispatched: %w", err)
	}

	sessionID, pid, err := startProcess(workdir, task.Instructions)
	if err != nil {
		_ = cleanup(r.baseDir, task.ID)
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
		_ = cleanup(r.baseDir, task.ID)
		return fmt.Errorf("copilot: save: %w", err)
	}

	return nil
}

func (r *Runtime) Pause(ctx context.Context, id kernel.TaskID) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	killProcess(metaPID(task))

	paused, err := kernel.Apply(task, kernel.Paused{})
	if err != nil {
		return err
	}
	return r.repo.Save(ctx, paused)
}

func (r *Runtime) Resume(ctx context.Context, id kernel.TaskID, extra *kernel.Supplement) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	resumed, err := kernel.Apply(task, kernel.Resumed{Extra: extra})
	if err != nil {
		return err
	}

	sessionID, _ := task.Metadata["copilot.session_id"].(string)
	workdir, _ := task.Metadata["copilot.workdir"].(string)
	prompt := task.Instructions
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

func (r *Runtime) Kill(ctx context.Context, id kernel.TaskID) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	killProcess(metaPID(task))

	cancelled, err := kernel.Apply(task, kernel.Cancelled{})
	if err != nil {
		return err
	}

	_ = cleanup(r.baseDir, id)
	return r.repo.Save(ctx, cancelled)
}

func (r *Runtime) Complete(ctx context.Context, id kernel.TaskID, result kernel.Result) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}
	completed, err := kernel.Apply(task, kernel.Completed{Result: result})
	if err != nil {
		return err
	}
	return r.repo.Save(ctx, completed)
}

func (r *Runtime) Fail(ctx context.Context, id kernel.TaskID, failure kernel.Failure) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}
	failed, err := kernel.Apply(task, kernel.Failed{Failure: failure})
	if err != nil {
		return err
	}
	return r.repo.Save(ctx, failed)
}

// metaPID extracts PID from task metadata.
func metaPID(task kernel.Task) int {
	if task.Metadata == nil {
		return 0
	}
	switch v := task.Metadata["copilot.pid"].(type) {
	case int:
		return v
	case float64:
		return int(v)
	}
	return 0
}
