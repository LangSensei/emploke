package copilot

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/LangSensei/emploke/agent"
	"github.com/LangSensei/emploke/task"
)

// startProcess launches a Copilot CLI process and returns the session ID and PID.
func startProcess(workdir, prompt string) (sessionID string, pid int, err error) {
	sessionID = newUUID()

	cmd := exec.Command("copilot",
		"-p", prompt,
		"--resume="+sessionID,
		"--yolo",
		"--output-format", "json",
	)
	cmd.Dir = workdir
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return "", 0, fmt.Errorf("start copilot: %w", err)
	}

	// Detach — we track by PID, not by process handle.
	// The goroutine reaps the zombie when the process exits.
	go cmd.Wait()

	return sessionID, cmd.Process.Pid, nil
}

// resumeProcess restarts a previously paused session.
func resumeProcess(sessionID, workdir, prompt string) (pid int, err error) {
	cmd := exec.Command("copilot",
		"-p", prompt,
		"--resume="+sessionID,
		"--yolo",
		"--output-format", "json",
	)
	cmd.Dir = workdir
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("resume copilot: %w", err)
	}

	go cmd.Wait()

	return cmd.Process.Pid, nil
}

// killProcess terminates a process by PID. Best-effort, cross-platform.
func killProcess(pid int) {
	if pid <= 0 {
		return
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = p.Kill()
}

// provision prepares the execution environment for a task.
func (r *Runtime) provision(ctx context.Context, t task.Task, ag agent.Agent) (string, error) {
	workdir := filepath.Join(r.baseDir, string(t.ID))

	if err := os.MkdirAll(workdir, 0755); err != nil {
		return "", fmt.Errorf("create workdir: %w", err)
	}

	// 1. Init git (Copilot CLI requires .git)
	cmd := exec.Command("git", "init")
	cmd.Dir = workdir
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git init: %s: %w", out, err)
	}

	// 2. Resolve all resources
	result, err := r.registry.ResolveForProvision(ctx, ag)
	if err != nil {
		return "", fmt.Errorf("resolve: %w", err)
	}

	// 3. Copy skills (including agent itself) to .github/skills/
	for _, skill := range result.Skills {
		dst := filepath.Join(workdir, ".github", "skills", skill.Name)
		if err := copyDir(skill.Path, dst); err != nil {
			return "", fmt.Errorf("copy skill %q: %w", skill.Name, err)
		}
	}

	// 4. Assemble .mcp.json (Copilot CLI format)
	if len(result.MCPs) > 0 {
		mcpServers := make(map[string]any)
		for _, mcp := range result.MCPs {
			mcpServers[mcp.Name] = mcp.Config
		}
		config := map[string]any{"mcpServers": mcpServers}
		data, err := json.MarshalIndent(config, "", "  ")
		if err != nil {
			return "", fmt.Errorf("marshal mcp config: %w", err)
		}
		data = append(data, '\n')
		if err := os.WriteFile(filepath.Join(workdir, ".mcp.json"), data, 0644); err != nil {
			return "", fmt.Errorf("write .mcp.json: %w", err)
		}
	}

	return workdir, nil
}

// cleanup removes a provisioned working directory.
func cleanup(baseDir string, id task.TaskID) error {
	workdir := filepath.Join(baseDir, string(id))
	return os.RemoveAll(workdir)
}

// newUUID generates a random UUID v4 string.
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// copyDir recursively copies src to dst.
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)

		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		return copyFile(path, target)
	})
}

// copyFile copies a single file.
func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
