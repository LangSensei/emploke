package fs_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/LangSensei/emploke/catalog"
	regfs "github.com/LangSensei/emploke/catalog/fs"
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
	if err != catalog.ErrNotFound {
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

	agent := catalog.Agent{
		Name:         "new-agent",
		Capabilities: []catalog.Capability{{Name: "planning"}},
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
	if err != catalog.ErrNotFound {
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
	reg, dir := setupTestRegistry(t)
	ctx := context.Background()

	// Add an unreferenced skill
	os.MkdirAll(filepath.Join(dir, "skills", "unused"), 0755)
	os.WriteFile(filepath.Join(dir, "skills", "unused", "SKILL.md"), []byte(`---
name: unused
version: "1.0.0"
type: skill
---
`), 0644)

	orphans, err := reg.Orphans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// "planning" is reachable via researcher→xiaohongshu→planning, not orphan
	// "unused" is not reachable by any agent, is orphan
	names := make(map[string]bool)
	for _, o := range orphans {
		names[o.Name] = true
	}
	if names["planning"] {
		t.Error("planning should NOT be orphan (reachable via xiaohongshu)")
	}
	if !names["unused"] {
		t.Errorf("expected unused to be orphan, got %v", names)
	}
}

func TestRegisterAndGetCapability_Skill(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	cap := catalog.Capability{
		Name: "new-skill",
		Metadata: map[string]any{
			"type":       "skill",
			"version":    "2.0.0",
			"dep_skills": []string{"planning"},
			"dep_mcps":   []string{"playwright"},
			"body":       "# New Skill\n\nSome content.",
		},
	}
	if err := reg.RegisterCapability(ctx, cap); err != nil {
		t.Fatal(err)
	}

	got, err := reg.GetCapability(ctx, "new-skill")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "new-skill" {
		t.Fatalf("expected new-skill, got %s", got.Name)
	}
	if got.Metadata["type"] != "skill" {
		t.Fatalf("expected type=skill, got %v", got.Metadata["type"])
	}
	if got.Metadata["version"] != "2.0.0" {
		t.Fatalf("expected version 2.0.0, got %v", got.Metadata["version"])
	}
}

func TestRegisterAndGetCapability_MCP(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	cap := catalog.Capability{
		Name: "new-mcp",
		Metadata: map[string]any{
			"type":    "mcp",
			"command": "node",
			"args":    []any{"server.js"},
		},
	}
	if err := reg.RegisterCapability(ctx, cap); err != nil {
		t.Fatal(err)
	}

	got, err := reg.GetCapability(ctx, "new-mcp")
	if err != nil {
		t.Fatal(err)
	}
	if got.Metadata["command"] != "node" {
		t.Fatalf("expected command=node, got %v", got.Metadata["command"])
	}
}

func TestResolve_CyclicDependencies(t *testing.T) {
	reg, dir := setupTestRegistry(t)
	ctx := context.Background()

	// Create cycle: skill-a → skill-b → skill-a
	os.MkdirAll(filepath.Join(dir, "skills", "skill-a"), 0755)
	os.WriteFile(filepath.Join(dir, "skills", "skill-a", "SKILL.md"), []byte(`---
name: skill-a
version: "1.0.0"
type: skill
dependencies:
  skills: [skill-b]
  mcps: []
---
`), 0644)

	os.MkdirAll(filepath.Join(dir, "skills", "skill-b"), 0755)
	os.WriteFile(filepath.Join(dir, "skills", "skill-b", "SKILL.md"), []byte(`---
name: skill-b
version: "1.0.0"
type: skill
dependencies:
  skills: [skill-a]
  mcps: []
---
`), 0644)

	// Agent referencing skill-a
	os.MkdirAll(filepath.Join(dir, "agents", "cyclic"), 0755)
	os.WriteFile(filepath.Join(dir, "agents", "cyclic", "AGENT.md"), []byte(`---
name: cyclic
version: "1.0.0"
type: agent
capabilities:
  skills: [skill-a]
  mcps: []
---
`), 0644)

	agent, _ := reg.GetAgent(ctx, "cyclic")
	caps, err := reg.Resolve(ctx, agent)
	if err != nil {
		t.Fatalf("cyclic resolve should not error, got: %v", err)
	}
	// Should get both skill-a and skill-b, no infinite loop
	if len(caps) != 2 {
		t.Fatalf("expected 2 capabilities, got %d", len(caps))
	}
}

func TestDependents(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	// "researcher" directly references "xiaohongshu" and "playwright"
	deps, err := reg.Dependents(ctx, "xiaohongshu")
	if err != nil {
		t.Fatal(err)
	}
	if len(deps) != 1 || deps[0].Name != "researcher" {
		t.Fatalf("expected [researcher], got %v", deps)
	}

	// "planning" is not directly referenced by any agent
	deps, err = reg.Dependents(ctx, "planning")
	if err != nil {
		t.Fatal(err)
	}
	if len(deps) != 0 {
		t.Fatalf("expected no dependents for planning, got %v", deps)
	}
}

func TestEmptyRegistry(t *testing.T) {
	dir := t.TempDir()
	reg, err := regfs.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	agents, err := reg.ListAgents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 0 {
		t.Fatalf("expected 0 agents, got %d", len(agents))
	}

	caps, err := reg.ListCapabilities(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(caps) != 0 {
		t.Fatalf("expected 0 capabilities, got %d", len(caps))
	}

	orphans, err := reg.Orphans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(orphans) != 0 {
		t.Fatalf("expected 0 orphans, got %d", len(orphans))
	}
}

func TestRegisterAgent_Idempotent(t *testing.T) {
	reg, _ := setupTestRegistry(t)
	ctx := context.Background()

	agent := catalog.Agent{
		Name:         "researcher",
		Capabilities: []catalog.Capability{{Name: "xiaohongshu"}},
		Metadata: map[string]any{
			"version": "2.0.0",
			"skills":  []string{"xiaohongshu"},
			"mcps":    []string{},
		},
	}

	// Register over existing
	if err := reg.RegisterAgent(ctx, agent); err != nil {
		t.Fatal(err)
	}

	got, err := reg.GetAgent(ctx, "researcher")
	if err != nil {
		t.Fatal(err)
	}
	if got.Metadata["version"] != "2.0.0" {
		t.Fatalf("expected version 2.0.0 after overwrite, got %v", got.Metadata["version"])
	}
	// Should have 1 capability now, not 2
	if len(got.Capabilities) != 1 {
		t.Fatalf("expected 1 capability after overwrite, got %d", len(got.Capabilities))
	}
}

func TestParseFrontmatter_NoFrontmatter(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "skills", "bare"), 0755)
	path := filepath.Join(dir, "skills", "bare", "SKILL.md")
	os.WriteFile(path, []byte("# Just a markdown file\n\nNo frontmatter here.\n"), 0644)

	reg, _ := regfs.New(dir)
	ctx := context.Background()

	cap, err := reg.GetCapability(ctx, "bare")
	if err != nil {
		t.Fatal(err)
	}
	// Name will be empty since no frontmatter
	if cap.Name != "" {
		t.Fatalf("expected empty name for no-frontmatter file, got %q", cap.Name)
	}
}

func TestResolve_MultiLevel(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "agents", "deep"), 0755)
	os.MkdirAll(filepath.Join(dir, "skills", "a"), 0755)
	os.MkdirAll(filepath.Join(dir, "skills", "b"), 0755)
	os.MkdirAll(filepath.Join(dir, "skills", "c"), 0755)
	os.MkdirAll(filepath.Join(dir, "mcps"), 0755)

	os.WriteFile(filepath.Join(dir, "agents", "deep", "AGENT.md"), []byte(`---
name: deep
version: "1.0.0"
type: agent
capabilities:
  skills: [a]
  mcps: []
---
`), 0644)

	os.WriteFile(filepath.Join(dir, "skills", "a", "SKILL.md"), []byte(`---
name: a
version: "1.0.0"
type: skill
dependencies:
  skills: [b]
  mcps: []
---
`), 0644)

	os.WriteFile(filepath.Join(dir, "skills", "b", "SKILL.md"), []byte(`---
name: b
version: "1.0.0"
type: skill
dependencies:
  skills: [c]
  mcps: []
---
`), 0644)

	os.WriteFile(filepath.Join(dir, "skills", "c", "SKILL.md"), []byte(`---
name: c
version: "1.0.0"
type: skill
---
`), 0644)

	reg, _ := regfs.New(dir)
	ctx := context.Background()

	agent, _ := reg.GetAgent(ctx, "deep")
	caps, err := reg.Resolve(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}

	names := make(map[string]bool)
	for _, c := range caps {
		names[c.Name] = true
	}
	for _, expected := range []string{"a", "b", "c"} {
		if !names[expected] {
			t.Errorf("expected %s in resolved, got %v", expected, names)
		}
	}
	if len(caps) != 3 {
		t.Fatalf("expected 3, got %d", len(caps))
	}
}
