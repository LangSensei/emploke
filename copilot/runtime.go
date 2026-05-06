package copilot

import (
	"context"
	"fmt"

	"github.com/LangSensei/emploke/kernel"
)

// Runtime implements [kernel.Runtime] for the Copilot CLI substrate.
type Runtime struct {
	repo    kernel.Repository
	prov    Provisioner
	proc    ProcessManager
	agents  interface{ GetAgent(context.Context, string) (kernel.Agent, error) }
	resolve interface{ Resolve(context.Context, kernel.Agent) ([]kernel.Capability, error) }
}

// NewRuntime creates a Runtime from the given Config.
func NewRuntime(cfg Config) *Runtime {
	return &Runtime{
		repo:    cfg.Repo,
		prov:    cfg.Provisioner,
		proc:    cfg.ProcessManager,
		agents:  cfg.Agents,
		resolve: cfg.Resolver,
	}
}

func (r *Runtime) Dispatch(ctx context.Context, task kernel.Task) error {
	// 1. Look up agent profile
	agent, err := r.agents.GetAgent(ctx, task.AgentName)
	if err != nil {
		return fmt.Errorf("copilot: agent %q: %w", task.AgentName, err)
	}

	// 2. Resolve all capabilities
	if _, err := r.resolve.Resolve(ctx, agent); err != nil {
		return fmt.Errorf("copilot: resolve capabilities: %w", err)
	}

	// 3. Provision environment
	workdir, err := r.prov.Provision(task, agent)
	if err != nil {
		return fmt.Errorf("copilot: provision: %w", err)
	}

	// 4. Apply Dispatched event
	dispatched, err := kernel.Apply(task, kernel.Dispatched{})
	if err != nil {
		return fmt.Errorf("copilot: apply dispatched: %w", err)
	}

	// 5. Start CLI process
	sessionID, err := r.proc.Start(workdir, task.Instructions)
	if err != nil {
		_ = r.prov.Cleanup(task.ID)
		return fmt.Errorf("copilot: start process: %w", err)
	}

	// 6. Store session ID in task metadata
	if dispatched.Metadata == nil {
		dispatched.Metadata = make(map[string]any)
	}
	dispatched.Metadata["copilot.session_id"] = sessionID
	dispatched.Metadata["copilot.workdir"] = workdir

	// 7. Persist
	if err := r.repo.Save(ctx, dispatched); err != nil {
		_ = r.proc.Kill(sessionID)
		_ = r.prov.Cleanup(task.ID)
		return fmt.Errorf("copilot: save: %w", err)
	}

	return nil
}

func (r *Runtime) Pause(ctx context.Context, id kernel.TaskID) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	sessionID, _ := task.Metadata["copilot.session_id"].(string)
	if sessionID != "" {
		if err := r.proc.Kill(sessionID); err != nil {
			return fmt.Errorf("copilot: kill process: %w", err)
		}
	}

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
	prompt := task.Instructions
	if extra != nil && extra.Payload != nil {
		if s, ok := extra.Payload.(string); ok {
			prompt = s
		}
	}

	if err := r.proc.Resume(sessionID, prompt); err != nil {
		return fmt.Errorf("copilot: resume process: %w", err)
	}

	return r.repo.Save(ctx, resumed)
}

func (r *Runtime) Kill(ctx context.Context, id kernel.TaskID) error {
	task, err := r.repo.Load(ctx, id)
	if err != nil {
		return err
	}

	sessionID, _ := task.Metadata["copilot.session_id"].(string)
	if sessionID != "" {
		_ = r.proc.Kill(sessionID) // best-effort
	}

	cancelled, err := kernel.Apply(task, kernel.Cancelled{})
	if err != nil {
		return err
	}

	_ = r.prov.Cleanup(id) // best-effort
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
