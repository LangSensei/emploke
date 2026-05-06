package copilot

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/LangSensei/emploke/kernel"
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

// killProcess sends SIGTERM to a process by PID. Best-effort.
func killProcess(pid int) {
	if pid <= 0 {
		return
	}
	_ = syscall.Kill(pid, syscall.SIGTERM)
}

// provision prepares the execution environment for a task.
func provision(baseDir string, task kernel.Task, agent kernel.Agent, caps []kernel.Capability) (string, error) {
	workdir := filepath.Join(baseDir, string(task.ID))
	dotDir := filepath.Join(workdir, ".github")

	if err := os.MkdirAll(dotDir, 0755); err != nil {
		return "", fmt.Errorf("create workdir: %w", err)
	}

	// Write AGENTS.md
	instructions, _ := agent.Metadata["instructions"].(string)
	if instructions == "" {
		instructions = task.Instructions
	}
	agentFile := filepath.Join(workdir, "AGENTS.md")
	if err := os.WriteFile(agentFile, []byte(instructions), 0644); err != nil {
		return "", fmt.Errorf("write AGENTS.md: %w", err)
	}

	// Write .mcp.json if there are MCP capabilities
	mcpServers := make(map[string]any)
	for _, cap := range caps {
		if cfg, ok := cap.Metadata["mcp_config"]; ok {
			mcpServers[cap.Name] = cfg
		}
	}
	if len(mcpServers) > 0 {
		mcpConfig := map[string]any{"mcpServers": mcpServers}
		data, err := json.MarshalIndent(mcpConfig, "", "  ")
		if err != nil {
			return "", fmt.Errorf("marshal mcp config: %w", err)
		}
		mcpPath := filepath.Join(workdir, ".mcp.json")
		if err := os.WriteFile(mcpPath, data, 0644); err != nil {
			return "", fmt.Errorf("write .mcp.json: %w", err)
		}
	}

	// Clone repo if specified
	if repo, ok := agent.Metadata["repo"].(string); ok && repo != "" {
		cmd := exec.Command("git", "clone", repo, ".")
		cmd.Dir = workdir
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", fmt.Errorf("git clone: %s: %w", out, err)
		}
	} else {
		cmd := exec.Command("git", "init")
		cmd.Dir = workdir
		_ = cmd.Run()
	}

	return workdir, nil
}

// cleanup removes a provisioned working directory.
func cleanup(baseDir string, id kernel.TaskID) error {
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
