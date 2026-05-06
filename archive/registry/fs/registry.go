package fs

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/LangSensei/emploke/kernel"
	"github.com/LangSensei/emploke/registry"
)

// Registry implements [registry.Registry] backed by the file system.
type Registry struct {
	root string // base directory, must be set
}

// New creates a new file-system Registry rooted at the given directory.
// Returns an error if root is empty.
func New(root string) (*Registry, error) {
	if root == "" {
		return nil, fmt.Errorf("fs: registry root directory must be specified")
	}
	return &Registry{root: root}, nil
}

// --- AgentRegistry ---

func (r *Registry) GetAgent(_ context.Context, name string) (kernel.Agent, error) {
	path := filepath.Join(r.root, "agents", name, "AGENT.md")
	fm, _, err := parseFrontmatter(path)
	if err != nil {
		if os.IsNotExist(err) {
			return kernel.Agent{}, registry.ErrNotFound
		}
		return kernel.Agent{}, fmt.Errorf("fs: read agent %q: %w", name, err)
	}
	return agentFromFrontmatter(fm), nil
}

func (r *Registry) ListAgents(_ context.Context) ([]kernel.Agent, error) {
	names, err := listSubdirs(filepath.Join(r.root, "agents"))
	if err != nil {
		return nil, fmt.Errorf("fs: list agents: %w", err)
	}
	var agents []kernel.Agent
	for _, name := range names {
		path := filepath.Join(r.root, "agents", name, "AGENT.md")
		fm, _, err := parseFrontmatter(path)
		if err != nil {
			continue
		}
		agents = append(agents, agentFromFrontmatter(fm))
	}
	return agents, nil
}

func (r *Registry) RegisterAgent(_ context.Context, agent kernel.Agent) error {
	fm := frontmatter{
		Name:    agent.Name,
		Type:    "agent",
		Version: metaString(agent.Metadata, "version"),
		Capabilities: &depsBlock{
			Skills: metaStrings(agent.Metadata, "skills"),
			MCPs:   metaStrings(agent.Metadata, "mcps"),
		},
	}
	body := metaString(agent.Metadata, "body")
	path := filepath.Join(r.root, "agents", agent.Name, "AGENT.md")
	return writeFrontmatter(path, fm, body)
}

func (r *Registry) RemoveAgent(_ context.Context, name string) error {
	dir := filepath.Join(r.root, "agents", name)
	return os.RemoveAll(dir)
}

// --- CapabilityRegistry ---

func (r *Registry) GetCapability(_ context.Context, name string) (kernel.Capability, error) {
	// Try skill first
	path := filepath.Join(r.root, "skills", name, "SKILL.md")
	if _, err := os.Stat(path); err == nil {
		fm, body, err := parseFrontmatter(path)
		if err != nil {
			return kernel.Capability{}, fmt.Errorf("fs: read skill %q: %w", name, err)
		}
		return capFromSkill(fm, body), nil
	}

	// Try MCP
	path = filepath.Join(r.root, "mcps", name+".json")
	config, err := readMCPConfig(path)
	if err != nil {
		if os.IsNotExist(err) {
			return kernel.Capability{}, registry.ErrNotFound
		}
		return kernel.Capability{}, fmt.Errorf("fs: read mcp %q: %w", name, err)
	}
	return capFromMCP(name, config), nil
}

func (r *Registry) ListCapabilities(_ context.Context) ([]kernel.Capability, error) {
	var caps []kernel.Capability

	// Skills
	skills, err := listSubdirs(filepath.Join(r.root, "skills"))
	if err != nil {
		return nil, fmt.Errorf("fs: list skills: %w", err)
	}
	for _, name := range skills {
		path := filepath.Join(r.root, "skills", name, "SKILL.md")
		fm, body, err := parseFrontmatter(path)
		if err != nil {
			continue
		}
		caps = append(caps, capFromSkill(fm, body))
	}

	// MCPs
	mcps, err := listDir(filepath.Join(r.root, "mcps"), ".json")
	if err != nil {
		return nil, fmt.Errorf("fs: list mcps: %w", err)
	}
	for _, name := range mcps {
		path := filepath.Join(r.root, "mcps", name+".json")
		config, err := readMCPConfig(path)
		if err != nil {
			continue
		}
		caps = append(caps, capFromMCP(name, config))
	}

	return caps, nil
}

func (r *Registry) RegisterCapability(_ context.Context, cap kernel.Capability) error {
	capType := metaString(cap.Metadata, "type")
	switch capType {
	case "mcp":
		config := make(map[string]any)
		for k, v := range cap.Metadata {
			if k == "type" {
				continue
			}
			config[k] = v
		}
		path := filepath.Join(r.root, "mcps", cap.Name+".json")
		return writeMCPConfig(path, config)
	default: // skill
		fm := frontmatter{
			Name:    cap.Name,
			Type:    "skill",
			Version: metaString(cap.Metadata, "version"),
		}
		if skills := metaStrings(cap.Metadata, "dep_skills"); skills != nil {
			fm.Dependencies = &depsBlock{Skills: skills, MCPs: metaStrings(cap.Metadata, "dep_mcps")}
		} else if mcps := metaStrings(cap.Metadata, "dep_mcps"); mcps != nil {
			fm.Dependencies = &depsBlock{Skills: nil, MCPs: mcps}
		}
		body := metaString(cap.Metadata, "body")
		path := filepath.Join(r.root, "skills", cap.Name, "SKILL.md")
		return writeFrontmatter(path, fm, body)
	}
}

func (r *Registry) RemoveCapability(_ context.Context, name string) error {
	// Try skill directory
	dir := filepath.Join(r.root, "skills", name)
	if _, err := os.Stat(dir); err == nil {
		return os.RemoveAll(dir)
	}
	// Try MCP
	path := filepath.Join(r.root, "mcps", name+".json")
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// --- Resolver ---

func (r *Registry) Resolve(ctx context.Context, agent kernel.Agent) ([]kernel.Capability, error) {
	visited := make(map[string]bool)
	var result []kernel.Capability

	// Gather initial capability names from agent
	var queue []string
	for _, cap := range agent.Capabilities {
		queue = append(queue, cap.Name)
	}

	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		if visited[name] {
			continue
		}
		visited[name] = true

		cap, err := r.GetCapability(ctx, name)
		if err != nil {
			return nil, fmt.Errorf("resolve %q for agent %q: %w", name, agent.Name, err)
		}
		result = append(result, cap)

		// Recurse into skill dependencies
		depSkills := metaStrings(cap.Metadata, "dep_skills")
		depMCPs := metaStrings(cap.Metadata, "dep_mcps")
		for _, s := range depSkills {
			if !visited[s] {
				queue = append(queue, s)
			}
		}
		for _, m := range depMCPs {
			if !visited[m] {
				queue = append(queue, m)
			}
		}
	}

	return result, nil
}

func (r *Registry) Missing(ctx context.Context, agent kernel.Agent) ([]string, error) {
	var missing []string
	visited := make(map[string]bool)
	var queue []string
	for _, cap := range agent.Capabilities {
		queue = append(queue, cap.Name)
	}

	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		if visited[name] {
			continue
		}
		visited[name] = true

		cap, err := r.GetCapability(ctx, name)
		if err != nil {
			missing = append(missing, name)
			continue
		}

		depSkills := metaStrings(cap.Metadata, "dep_skills")
		depMCPs := metaStrings(cap.Metadata, "dep_mcps")
		for _, s := range depSkills {
			if !visited[s] {
				queue = append(queue, s)
			}
		}
		for _, m := range depMCPs {
			if !visited[m] {
				queue = append(queue, m)
			}
		}
	}

	return missing, nil
}

func (r *Registry) Dependents(ctx context.Context, capName string) ([]kernel.Agent, error) {
	agents, err := r.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	var result []kernel.Agent
	for _, agent := range agents {
		for _, cap := range agent.Capabilities {
			if cap.Name == capName {
				result = append(result, agent)
				break
			}
		}
	}
	return result, nil
}

func (r *Registry) Orphans(ctx context.Context) ([]kernel.Capability, error) {
	agents, err := r.ListAgents(ctx)
	if err != nil {
		return nil, err
	}

	// Collect all capabilities reachable from any agent (recursive)
	used := make(map[string]bool)
	for _, agent := range agents {
		caps, err := r.Resolve(ctx, agent)
		if err != nil {
			// If resolve fails (missing dep), still mark direct refs as used
			for _, cap := range agent.Capabilities {
				used[cap.Name] = true
			}
			continue
		}
		for _, cap := range caps {
			used[cap.Name] = true
		}
	}

	caps, err := r.ListCapabilities(ctx)
	if err != nil {
		return nil, err
	}
	var orphans []kernel.Capability
	for _, cap := range caps {
		if !used[cap.Name] {
			orphans = append(orphans, cap)
		}
	}
	return orphans, nil
}

// --- helpers ---

func agentFromFrontmatter(fm frontmatter) kernel.Agent {
	var caps []kernel.Capability
	if fm.Capabilities != nil {
		for _, s := range fm.Capabilities.Skills {
			caps = append(caps, kernel.Capability{Name: s})
		}
		for _, m := range fm.Capabilities.MCPs {
			caps = append(caps, kernel.Capability{Name: m})
		}
	}
	meta := map[string]any{
		"version": fm.Version,
	}
	if fm.Capabilities != nil {
		meta["skills"] = fm.Capabilities.Skills
		meta["mcps"] = fm.Capabilities.MCPs
	}
	return kernel.Agent{
		Name:         fm.Name,
		Capabilities: caps,
		Metadata:     meta,
	}
}

func capFromSkill(fm frontmatter, body string) kernel.Capability {
	meta := map[string]any{
		"type":    "skill",
		"version": fm.Version,
	}
	if body != "" {
		meta["body"] = body
	}
	if fm.Dependencies != nil {
		if len(fm.Dependencies.Skills) > 0 {
			meta["dep_skills"] = fm.Dependencies.Skills
		}
		if len(fm.Dependencies.MCPs) > 0 {
			meta["dep_mcps"] = fm.Dependencies.MCPs
		}
	}
	return kernel.Capability{
		Name:     fm.Name,
		Metadata: meta,
	}
}

func capFromMCP(name string, config map[string]any) kernel.Capability {
	meta := map[string]any{"type": "mcp"}
	for k, v := range config {
		meta[k] = v
	}
	return kernel.Capability{
		Name:     name,
		Metadata: meta,
	}
}

func metaString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, _ := m[key].(string)
	return v
}

func metaStrings(m map[string]any, key string) []string {
	if m == nil {
		return nil
	}
	switch v := m[key].(type) {
	case []string:
		return v
	case []any:
		var result []string
		for _, item := range v {
			if s, ok := item.(string); ok {
				result = append(result, s)
			}
		}
		return result
	}
	return nil
}

// Compile-time interface checks.
var _ registry.AgentRegistry = (*Registry)(nil)
var _ registry.CapabilityRegistry = (*Registry)(nil)
var _ registry.Resolver = (*Registry)(nil)
var _ registry.Registry = (*Registry)(nil)

// unexported helpers to avoid unused import
