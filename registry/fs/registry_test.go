package fs_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/LangSensei/emploke/kernel"
	"github.com/LangSensei/emploke/registry"
	regfs "github.com/LangSensei/emploke/registry/fs"
)

func setupTestRegistry(t *testing.T) (*regfs.Registry, string) {
	t.Helper()
	dir := t.TempDir()

	// Create directory structure
	os.MkdirAll(filepath.Join(dir, "agents", "researcher"), 0755)
	os.MkdirAll(filepath.Join(dir, "skills", "xiaohongshu"), 0755)
	os.MkdirAll(filepath.Join(dir, "skills", "planning"), 0755)
	os.MkdirAll(filepath.Join(dir, "mcps"), 0755)

	// Write a skill with dependencies
	os.WriteFile(filepath.Join(dir, "skills", "xiaohongshu", "SKILL.md"), []byte(`---
name: xiaohongshu
version: "1.2.0"
type: skill
dependencies:
  skills: [planning]
  mcps: [playwright]
---

# Xiaohongshu Skill

Browser automation for xiaohongshu.
`), 0644)

	// Write a skill without dependencies
	os.WriteFile(filepath.Join(dir, "skills", "planning", "SKILL.md"), []byte(`---
name: planning
version: "1.0.0"
type: skill
---

# Planning Skill
`), 0644)

	// Write an MCP
	os.WriteFile(filepath.Join(dir, "mcps", "playwright.json"), []byte(`{
  "command": "npx",
  "args": ["playwright-mcp"]
}
`), 0644)

	// Write an agent
	os.WriteFile(filepath.Join(dir, "agents", "researcher", "AGENT.md"), []byte(`---
name: researcher
version: "1.0.0"
type: agent
capabilities:
  skills: [xiaohongshu]
  mcps: [playwright]
---

# Researcher Agent
`), 0644)

	reg, err := regfs.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	return reg, dir
}

func TestNew_EmptyRoot(t *testing.T) {
	_, err := regfs.New("")
	if err == nil {
		t.Fatal("expected error for empty root")
	}
}

func TestGetAgent(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	agent, err := reg.GetAgent(ctx, "researcher")
	if err != nil {
		t.Fatal(err)
	}
	if agent.Name != "researcher" {
		t.Fatalf("expected researcher, got %s", agent.Name)
	}
	if len(agent.Capabilities) != 2 {
		t.Fatalf("expected 2 capabilities, got %d", len(agent.Capabilities))
	}
}

func TestGetAgent_NotFound(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	_, err := reg.GetAgent(ctx, "nonexistent")
	if err != registry.ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestGetCapability_Skill(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	cap, err := reg.GetCapability(ctx, "xiaohongshu")
	if err != nil {
		t.Fatal(err)
	}
	if cap.Name != "xiaohongshu" {
		t.Fatalf("expected xiaohongshu, got %s", cap.Name)
	}
	if cap.Metadata["type"] != "skill" {
		t.Fatalf("expected type=skill, got %v", cap.Metadata["type"])
	}
}

func TestGetCapability_MCP(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	cap, err := reg.GetCapability(ctx, "playwright")
	if err != nil {
		t.Fatal(err)
	}
	if cap.Name != "playwright" {
		t.Fatalf("expected playwright, got %s", cap.Name)
	}
	if cap.Metadata["type"] != "mcp" {
		t.Fatalf("expected type=mcp, got %v", cap.Metadata["type"])
	}
	if cap.Metadata["command"] != "npx" {
		t.Fatalf("expected command=npx, got %v", cap.Metadata["command"])
	}
}

func TestResolve_RecursiveDependencies(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	agent, _ := reg.GetAgent(ctx, "researcher")
	caps, err := reg.Resolve(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}

	// Should resolve: xiaohongshu, playwright (direct), plus planning (from xiaohongshu deps)
	names := make(map[string]bool)
	for _, c := range caps {
		names[c.Name] = true
	}

	expected := []string{"xiaohongshu", "playwright", "planning"}
	for _, e := range expected {
		if !names[e] {
			t.Errorf("expected %s in resolved capabilities, got %v", e, names)
		}
	}
}

func TestMissing(t *testing.T) {
	reg, dir := setupTestRegistry(t)
	ctx := context.Background()

	// Create agent referencing non-existent capability
	os.MkdirAll(filepath.Join(dir, "agents", "broken"), 0755)
	os.WriteFile(filepath.Join(dir, "agents", "broken", "AGENT.md"), []byte(`---
name: broken
version: "1.0.0"
type: agent
capabilities:
  skills: [nonexistent-skill]
  mcps: []
---
`), 0644)

	agent, _ := reg.GetAgent(ctx, "broken")
	missing, err := reg.Missing(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 1 || missing[0] != "nonexistent-skill" {
		t.Fatalf("expected [nonexistent-skill], got %v", missing)
	}
}

func TestRegisterAndRemoveAgent(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	agent := kernel.Agent{
		Name:         "new-agent",
		Capabilities: []kernel.Capability{{Name: "planning"}},
		Metadata: map[string]any{
			"version": "1.0.0",
			"skills":  []string{"planning"},
			"mcps":    []string{},
		},
	}

	if err := reg.RegisterAgent(ctx, agent); err != nil {
		t.Fatal(err)
	}

	got, err := reg.GetAgent(ctx, "new-agent")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "new-agent" {
		t.Fatalf("expected new-agent, got %s", got.Name)
	}

	if err := reg.RemoveAgent(ctx, "new-agent"); err != nil {
		t.Fatal(err)
	}
	_, err = reg.GetAgent(ctx, "new-agent")
	if err != registry.ErrNotFound {
		t.Fatalf("expected ErrNotFound after remove, got %v", err)
	}
}

func TestListAgents(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	agents, err := reg.ListAgents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(agents))
	}
}

func TestListCapabilities(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	caps, err := reg.ListCapabilities(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// 2 skills + 1 mcp = 3
	if len(caps) != 3 {
		t.Fatalf("expected 3 capabilities, got %d", len(caps))
	}
}

func TestOrphans(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	orphans, err := reg.Orphans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// planning is not directly referenced by any agent
	names := make(map[string]bool)
	for _, o := range orphans {
		names[o.Name] = true
	}
	if !names["planning"] {
		t.Errorf("expected planning to be orphan, got %v", names)
	}
}
