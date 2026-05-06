package copilot

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	logFile   *os.File
	done      chan struct{}
	exitCode  int
}

// processTable manages all active Copilot CLI processes.
type processTable struct {
	mu       sync.Mutex
	sessions map[string]*session // keyed by sessionID (= taskID)
}

func newProcessTable() *processTable {
	return &processTable{sessions: make(map[string]*session)}
}

// start launches a Copilot CLI process for the given task.
func (pt *processTable) start(taskID kernel.TaskID, workdir, prompt string) (string, error) {
	cmd := exec.Command("copilot", "-p", prompt, "--yolo", "--output-format", "json")
	cmd.Dir = workdir

	// Log output to file
	logPath := filepath.Join(workdir, "agent.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		return "", fmt.Errorf("create log file: %w", err)
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile

	if err := cmd.Start(); err != nil {
		logFile.Close()
		return "", fmt.Errorf("start copilot: %w", err)
	}

	sid := string(taskID)
	s := &session{
		cmd:       cmd,
		pid:       cmd.Process.Pid,
		sessionID: sid,
		workdir:   workdir,
		logFile:   logFile,
		done:      make(chan struct{}),
	}

	go func() {
		defer logFile.Close()
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
	pt.sessions[sid] = s
	pt.mu.Unlock()

	return sid, nil
}

// resume restarts a previously paused session using --resume.
func (pt *processTable) resume(sessionID, workdir, prompt string) error {
	cmd := exec.Command("copilot", "-p", prompt, "--resume", sessionID, "--yolo", "--output-format", "json")
	cmd.Dir = workdir

	logPath := filepath.Join(workdir, "agent.log")
	logFile, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile

	if err := cmd.Start(); err != nil {
		logFile.Close()
		return fmt.Errorf("resume copilot: %w", err)
	}

	s := &session{
		cmd:       cmd,
		pid:       cmd.Process.Pid,
		sessionID: sessionID,
		workdir:   workdir,
		logFile:   logFile,
		done:      make(chan struct{}),
	}

	go func() {
		defer logFile.Close()
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

	// Send SIGTERM, then wait
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

// pidFromMetadata extracts the PID from task metadata for persistence.
func pidFromMetadata(task kernel.Task) int {
	if v, ok := task.Metadata["copilot.pid"]; ok {
		switch p := v.(type) {
		case int:
			return p
		case float64:
			return int(p)
		case string:
			n, _ := strconv.Atoi(p)
			return n
		}
	}
	return 0
}
