package fs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/LangSensei/emploke/agent"
)

// Registry implements [agent.Registry] backed by the file system.
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

func (r *Registry) GetAgent(_ context.Context, name string) (agent.Agent, error) {
	path := filepath.Join(r.root, "agents", name, "AGENT.md")
	fm, _, err := parseFrontmatter(path)
	if err != nil {
		if os.IsNotExist(err) {
			return agent.Agent{}, agent.ErrNotFound
		}
		return agent.Agent{}, fmt.Errorf("fs: read agent %q: %w", name, err)
	}
	return agentFromFrontmatter(fm), nil
}

func (r *Registry) ListAgents(_ context.Context) ([]agent.Agent, error) {
	names, err := listSubdirs(filepath.Join(r.root, "agents"))
	if err != nil {
		return nil, fmt.Errorf("fs: list agents: %w", err)
	}
	var agents []agent.Agent
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

func (r *Registry) InstallAgent(_ context.Context, name string, srcPath string) error {
	// Validate AGENT.md exists and has valid frontmatter
	agentMD := filepath.Join(srcPath, "AGENT.md")
	fm, _, err := parseFrontmatter(agentMD)
	if err != nil {
		return fmt.Errorf("fs: install agent %q: %w", name, err)
	}
	if fm.Type != "" && fm.Type != "agent" {
		return fmt.Errorf("fs: install agent %q: invalid type %q, expected \"agent\"", name, fm.Type)
	}
	dst := filepath.Join(r.root, "agents", name)
	_ = os.RemoveAll(dst)
	return copyDir(srcPath, dst)
}

func (r *Registry) RemoveAgent(_ context.Context, name string) error {
	dir := filepath.Join(r.root, "agents", name)
	return os.RemoveAll(dir)
}

// --- CapabilityRegistry ---

func (r *Registry) GetCapability(_ context.Context, name string) (agent.Capability, error) {
	kind, localName := parseCapName(name)

	switch kind {
	case "skill":
		path := filepath.Join(r.root, "skills", localName, "SKILL.md")
		fm, body, err := parseFrontmatter(path)
		if err != nil {
			if os.IsNotExist(err) {
				return agent.Capability{}, agent.ErrNotFound
			}
			return agent.Capability{}, fmt.Errorf("fs: read skill %q: %w", name, err)
		}
		cap := capFromSkill(fm, body)
		cap.Name = name // use qualified name
		return cap, nil
	case "mcp":
		path := filepath.Join(r.root, "mcps", localName+".json")
		config, err := readMCPConfig(path)
		if err != nil {
			if os.IsNotExist(err) {
				return agent.Capability{}, agent.ErrNotFound
			}
			return agent.Capability{}, fmt.Errorf("fs: read mcp %q: %w", name, err)
		}
		cap := capFromMCP(name, config)
		return cap, nil
	default:
		// No prefix — try skill then mcp (backwards compat)
		path := filepath.Join(r.root, "skills", name, "SKILL.md")
		if _, err := os.Stat(path); err == nil {
			fm, body, err := parseFrontmatter(path)
			if err != nil {
				return agent.Capability{}, fmt.Errorf("fs: read skill %q: %w", name, err)
			}
			return capFromSkill(fm, body), nil
		}
		path = filepath.Join(r.root, "mcps", name+".json")
		config, err := readMCPConfig(path)
		if err != nil {
			if os.IsNotExist(err) {
				return agent.Capability{}, agent.ErrNotFound
			}
			return agent.Capability{}, fmt.Errorf("fs: read mcp %q: %w", name, err)
		}
		return capFromMCP(name, config), nil
	}
}

func (r *Registry) ListCapabilities(_ context.Context) ([]agent.Capability, error) {
	var caps []agent.Capability

	// Skills (walk for nested scope dirs)
	skillsDir := filepath.Join(r.root, "skills")
	if entries, err := os.ReadDir(skillsDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			// Could be scope/name or direct name
			subPath := filepath.Join(skillsDir, e.Name(), "SKILL.md")
			if _, err := os.Stat(subPath); err == nil {
				// Direct: skills/<name>/SKILL.md
				fm, body, _ := parseFrontmatter(subPath)
				cap := capFromSkill(fm, body)
				cap.Name = "skill:" + e.Name()
				caps = append(caps, cap)
			} else {
				// Scope dir: skills/<scope>/<name>/SKILL.md
				scopeDir := filepath.Join(skillsDir, e.Name())
				subEntries, _ := os.ReadDir(scopeDir)
				for _, se := range subEntries {
					if !se.IsDir() {
						continue
					}
					p := filepath.Join(scopeDir, se.Name(), "SKILL.md")
					if fm, body, err := parseFrontmatter(p); err == nil {
						cap := capFromSkill(fm, body)
						cap.Name = "skill:" + e.Name() + "/" + se.Name()
						caps = append(caps, cap)
					}
				}
			}
		}
	}

	// MCPs (walk for nested scope dirs)
	mcpsDir := filepath.Join(r.root, "mcps")
	if entries, err := os.ReadDir(mcpsDir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				// Scope dir: mcps/<scope>/<name>.json
				scopeDir := filepath.Join(mcpsDir, e.Name())
				subEntries, _ := os.ReadDir(scopeDir)
				for _, se := range subEntries {
					if se.IsDir() || filepath.Ext(se.Name()) != ".json" {
						continue
					}
					p := filepath.Join(scopeDir, se.Name())
					config, err := readMCPConfig(p)
					if err != nil {
						continue
					}
					name := strings.TrimSuffix(se.Name(), ".json")
					caps = append(caps, capFromMCP("mcp:"+e.Name()+"/"+name, config))
				}
			} else if filepath.Ext(e.Name()) == ".json" {
				// Direct: mcps/<name>.json
				p := filepath.Join(mcpsDir, e.Name())
				config, err := readMCPConfig(p)
				if err != nil {
					continue
				}
				name := strings.TrimSuffix(e.Name(), ".json")
				caps = append(caps, capFromMCP("mcp:"+name, config))
			}
		}
	}

	return caps, nil
}

func (r *Registry) Install(_ context.Context, name string, srcPath string) error {
	info, err := os.Stat(srcPath)
	if err != nil {
		return fmt.Errorf("fs: install %q: %w", name, err)
	}

	if info.IsDir() {
		// Skill: validate SKILL.md exists and has valid frontmatter
		skillMD := filepath.Join(srcPath, "SKILL.md")
		fm, _, err := parseFrontmatter(skillMD)
		if err != nil {
			return fmt.Errorf("fs: install skill %q: %w", name, err)
		}
		if fm.Type != "" && fm.Type != "skill" {
			return fmt.Errorf("fs: install skill %q: invalid type %q, expected \"skill\"", name, fm.Type)
		}
		dst := filepath.Join(r.root, "skills", name)
		_ = os.RemoveAll(dst)
		return copyDir(srcPath, dst)
	}

	// MCP: validate json is parseable and has required fields
	data, err := os.ReadFile(srcPath)
	if err != nil {
		return fmt.Errorf("fs: install mcp %q: %w", name, err)
	}
	var config map[string]any
	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("fs: install mcp %q: invalid json: %w", name, err)
	}
	if _, ok := config["type"]; !ok {
		return fmt.Errorf("fs: install mcp %q: missing \"type\" field (stdio/http)", name)
	}
	dst := filepath.Join(r.root, "mcps", name+".json")
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	return copyFile(srcPath, dst)
}

func (r *Registry) Remove(_ context.Context, name string) error {
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

func (r *Registry) Resolve(ctx context.Context, ag agent.Agent) ([]agent.Capability, error) {
	visited := make(map[string]bool)
	var result []agent.Capability

	// Gather initial capability names from agent
	var queue []string
	for _, cap := range ag.Capabilities {
		queue = append(queue, cap)
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
			return nil, fmt.Errorf("resolve %q for agent %q: %w", name, ag.Name, err)
		}
		result = append(result, cap)

		// Recurse into dependencies
		for _, dep := range cap.Capabilities {
			if !visited[dep] {
				queue = append(queue, dep)
			}
		}
	}

	return result, nil
}

func (r *Registry) Missing(ctx context.Context, ag agent.Agent) ([]string, error) {
	var missing []string
	visited := make(map[string]bool)
	var queue []string
	for _, cap := range ag.Capabilities {
		queue = append(queue, cap)
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

		for _, dep := range cap.Capabilities {
			if !visited[dep] {
				queue = append(queue, dep)
			}
		}
	}

	return missing, nil
}

func (r *Registry) Dependents(ctx context.Context, capName string) ([]agent.Agent, error) {
	agents, err := r.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	var result []agent.Agent
	for _, a := range agents {
		for _, cap := range a.Capabilities {
			if cap == capName {
				result = append(result, a)
				break
			}
		}
	}
	return result, nil
}

func (r *Registry) Orphans(ctx context.Context) ([]agent.Capability, error) {
	agents, err := r.ListAgents(ctx)
	if err != nil {
		return nil, err
	}

	// Collect all capability names reachable from any agent (recursive)
	used := make(map[string]bool)
	for _, a := range agents {
		caps, err := r.Resolve(ctx, a)
		if err != nil {
			// If resolve fails (missing dep), still mark direct refs as used
			for _, c := range a.Capabilities {
				used[c] = true
			}
			continue
		}
		for _, c := range caps {
			used[c.Name] = true
		}
	}

	caps, err := r.ListCapabilities(ctx)
	if err != nil {
		return nil, err
	}
	var orphans []agent.Capability
	for _, c := range caps {
		if !used[c.Name] {
			orphans = append(orphans, c)
		}
	}
	return orphans, nil
}

// --- helpers ---

func agentFromFrontmatter(fm frontmatter) agent.Agent {
	var caps []string
	if fm.Capabilities != nil {
		for _, s := range fm.Capabilities.Skills {
			caps = append(caps, "skill:"+s)
		}
		for _, m := range fm.Capabilities.MCPs {
			caps = append(caps, "mcp:"+m)
		}
	}
	meta := map[string]any{
		"version": fm.Version,
	}
	return agent.Agent{
		Name:         fm.Name,
		Capabilities: caps,
		Metadata:     meta,
	}
}

func capFromSkill(fm frontmatter, body string) agent.Capability {
	meta := map[string]any{
		"version": fm.Version,
	}
	if body != "" {
		meta["body"] = body
	}
	var caps []string
	if fm.Dependencies != nil {
		for _, s := range fm.Dependencies.Skills {
			caps = append(caps, "skill:"+s)
		}
		for _, m := range fm.Dependencies.MCPs {
			caps = append(caps, "mcp:"+m)
		}
	}
	return agent.Capability{
		Name:         fm.Name,
		Capabilities: caps,
		Metadata:     meta,
	}
}

func capFromMCP(name string, config map[string]any) agent.Capability {
	meta := make(map[string]any)
	for k, v := range config {
		meta[k] = v
	}
	return agent.Capability{
		Name:     name,
		Metadata: meta,
	}
}

// parseCapName splits "skill:scope/name" into ("skill", "scope/name").
// If no prefix, returns ("", name).
func parseCapName(name string) (kind, localName string) {
	if i := strings.Index(name, ":"); i >= 0 {
		return name[:i], name[i+1:]
	}
	return "", name
}

func metaString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, _ := m[key].(string)
	return v
}
