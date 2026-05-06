package copilot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/LangSensei/emploke/catalog"
	"github.com/LangSensei/emploke/session/headless"
)

// Runtime implements [substrate.Runtime] for the Copilot CLI substrate.
//
// All side-effecting operations (process management, filesystem provisioning)
// are injected as function fields so tests can mock them.
type Runtime struct {
	repo     headless.Repository
	agents   catalog.AgentRegistry
	resolver catalog.Resolver
	baseDir  string

	// Injected operations — overridable for testing.
	startProcess  func(workdir, prompt string) (sessionID string, pid int, err error)
	resumeProcess func(sessionID, workdir, prompt string) (pid int, err error)
	killProcess   func(pid int)
	provision     func(baseDir string, task headless.Task, agent catalog.Agent, caps []catalog.Capability) (workdir string, err error)
	cleanup       func(baseDir string, id headless.TaskID) error
}

// NewRuntime creates a Runtime from the given Config, wired with the real
// (production) process and provisioning operations.
func NewRuntime(cfg Config) *Runtime {
	baseDir := cfg.BaseDir
	if baseDir == "" {
		home, _ := os.UserHomeDir()
		baseDir = filepath.Join(home, ".copilot", "tasks")
	}
	return &Runtime{
		repo:          cfg.Repo,
		agents:        cfg.Agents,
		resolver:      cfg.Resolver,
		baseDir:       baseDir,
		startProcess:  defaultStartProcess,
		resumeProcess: defaultResumeProcess,
		killProcess:   defaultKillProcess,
		provision:     defaultProvision,
		cleanup:       defaultCleanup,
	}
}

func (r *Runtime) Dispatch(ctx context.Context, task headless.Task) error {
	agent, err := r.agents.GetAgent(ctx, task.AgentName)
	if err != nil {
		return fmt.Errorf("copilot: agent %q: %w", task.AgentName, err)
	}

	caps, err := r.resolver.Resolve(ctx, agent)
	if err != nil {
		return fmt.Errorf("copilot: resolve capabilities: %w", err)
	}

	workdir, err := r.provision(r.baseDir, task, agent, caps)
	if err != nil {
		return fmt.Errorf("copilot: provision: %w", err)
	}

	dispatched, err := headless.Apply(task, headless.Dispatched{})
	if err != nil {
		_ = r.cleanup(r.baseDir, task.ID)
		return fmt.Errorf("copilot: apply dispatched: %w", err)
	}

	sessionID, pid, err := r.startProcess(workdir, task.Instructions)
	if err != nil {
		_ = r.cleanup(r.baseDir, task.ID)
		return fmt.Errorf("copilot: %w", err)
	}

	if dispatched.Metadata == nil {
		dispatched.Metadata = make(map[string]any)
	}
	dispatched.Metadata["copilot.session_id"] = sessionID
	dispatched.Metadata["copilot.workdir"] = workdir
	dispatched.Metadata["copilot.pid"] = pid

	if err := r.repo.Save(ctx, dispatched); err != nil {
		r.killProcess(pid)
		_ = r.cleanup(r.baseDir, task.ID)
		return fmt.Errorf("copilot: save: %w", err)
	}

	return nil
}

func (r *Runtime) Pause(ctx context.Context, id headless.TaskID) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	r.killProcess(metaPID(task))

	paused, err := headless.Apply(task, headless.Paused{})
	if err != nil {
		return err
	}
	return r.repo.Save(ctx, paused)
}

func (r *Runtime) Resume(ctx context.Context, id headless.TaskID, extra *headless.Supplement) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	resumed, err := headless.Apply(task, headless.Resumed{Extra: extra})
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

	pid, err := r.resumeProcess(sessionID, workdir, prompt)
	if err != nil {
		return fmt.Errorf("copilot: %w", err)
	}

	if resumed.Metadata == nil {
		resumed.Metadata = make(map[string]any)
	}
	resumed.Metadata["copilot.pid"] = pid

	return r.repo.Save(ctx, resumed)
}

func (r *Runtime) Kill(ctx context.Context, id headless.TaskID) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	r.killProcess(metaPID(task))

	cancelled, err := headless.Apply(task, headless.Cancelled{})
	if err != nil {
		return err
	}

	_ = r.cleanup(r.baseDir, id)
	return r.repo.Save(ctx, cancelled)
}

func (r *Runtime) Complete(ctx context.Context, id headless.TaskID, result headless.Result) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}
	completed, err := headless.Apply(task, headless.Completed{Result: result})
	if err != nil {
		return err
	}
	return r.repo.Save(ctx, completed)
}

func (r *Runtime) Fail(ctx context.Context, id headless.TaskID, failure headless.Failure) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}
	failed, err := headless.Apply(task, headless.Failed{Failure: failure})
	if err != nil {
		return err
	}
	return r.repo.Save(ctx, failed)
}

// metaPID extracts PID from task metadata.
func metaPID(task headless.Task) int {
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
