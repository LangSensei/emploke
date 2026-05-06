package copilot

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/LangSensei/emploke/kernel"
)

// session tracks a running Copilot CLI process.
type session struct {
	cmd       *exec.Cmd
	pid       int
	sessionID string
	workdir   string
	done      chan struct{}
	exitCode  int
}

// processTable manages all active Copilot CLI processes.
type processTable struct {
	mu       sync.Mutex
	sessions map[string]*session // keyed by sessionID
}

func newProcessTable() *processTable {
	return &processTable{sessions: make(map[string]*session)}
}

// start launches a Copilot CLI process with a new session ID.
func (pt *processTable) start(workdir, prompt string) (string, error) {
	sessionID := newUUID()

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
		return "", fmt.Errorf("start copilot: %w", err)
	}

	s := &session{
		cmd:       cmd,
		pid:       cmd.Process.Pid,
		sessionID: sessionID,
		workdir:   workdir,
		done:      make(chan struct{}),
	}

	go func() {
		defer close(s.done)
		if err := cmd.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				s.exitCode = exitErr.ExitCode()
			} else {
				s.exitCode = -1
			}
		}
	}()

	pt.mu.Lock()
	pt.sessions[sessionID] = s
	pt.mu.Unlock()

	return sessionID, nil
}

// resume restarts a previously paused session.
func (pt *processTable) resume(sessionID, workdir, prompt string) error {
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
		return fmt.Errorf("resume copilot: %w", err)
	}

	s := &session{
		cmd:       cmd,
		pid:       cmd.Process.Pid,
		sessionID: sessionID,
		workdir:   workdir,
		done:      make(chan struct{}),
	}

	go func() {
		defer close(s.done)
		if err := cmd.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				s.exitCode = exitErr.ExitCode()
			} else {
				s.exitCode = -1
			}
		}
	}()

	pt.mu.Lock()
	pt.sessions[sessionID] = s
	pt.mu.Unlock()

	return nil
}

// kill terminates a running process.
func (pt *processTable) kill(sessionID string) error {
	pt.mu.Lock()
	s, ok := pt.sessions[sessionID]
	pt.mu.Unlock()
	if !ok {
		return nil // already gone
	}

	if s.cmd.Process != nil {
		_ = s.cmd.Process.Signal(syscall.SIGTERM)
	}
	<-s.done

	pt.mu.Lock()
	delete(pt.sessions, sessionID)
	pt.mu.Unlock()

	return nil
}

// isRunning reports whether the process is still alive.
func (pt *processTable) isRunning(sessionID string) bool {
	pt.mu.Lock()
	s, ok := pt.sessions[sessionID]
	pt.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

// provision prepares the execution environment for a task.
// It creates a working directory, writes AGENTS.md, and sets up MCP config.
func provision(baseDir string, task kernel.Task, agent kernel.Agent, caps []kernel.Capability) (string, error) {
	workdir := filepath.Join(baseDir, string(task.ID))
	dotDir := filepath.Join(workdir, ".github")

	if err := os.MkdirAll(dotDir, 0755); err != nil {
		return "", fmt.Errorf("create workdir: %w", err)
	}

	// Write AGENTS.md from agent instructions (stored in Metadata)
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
		// Init git so Copilot CLI can discover .github/
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
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 1
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
