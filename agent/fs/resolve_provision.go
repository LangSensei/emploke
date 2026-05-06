package fs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/LangSensei/emploke/agent"
)

// ResolveForProvision returns all resources needed to provision an agent's
// execution environment. The agent directory itself is included as the first
// skill entry.
func (r *Registry) ResolveForProvision(ctx context.Context, ag agent.Agent) (agent.ResolveResult, error) {
	var result agent.ResolveResult

	// Agent itself as a skill
	agentDir := filepath.Join(r.root, "agents", ag.Name)
	if _, err := os.Stat(agentDir); err == nil {
		result.Skills = append(result.Skills, agent.SkillRef{
			Name: ag.Name,
			Path: agentDir,
		})
	}

	// BFS resolve all capabilities
	visited := make(map[string]bool)
	queue := append([]string{}, ag.Capabilities...)

	for len(queue) > 0 {
		qualName := queue[0]
		queue = queue[1:]
		if visited[qualName] {
			continue
		}
		visited[qualName] = true

		kind, localName := parseCapName(qualName)

		switch kind {
		case "skill", "":
			skillDir := filepath.Join(r.root, "skills", localName)
			skillMD := filepath.Join(skillDir, "SKILL.md")
			if _, err := os.Stat(skillMD); err != nil {
				continue // skip missing
			}
			result.Skills = append(result.Skills, agent.SkillRef{
				Name: localName,
				Path: skillDir,
			})
			// Parse dependencies and enqueue
			fm, _, _ := parseFrontmatter(skillMD)
			if fm.Dependencies != nil {
				for _, s := range fm.Dependencies.Skills {
					dep := "skill:" + s
					if !visited[dep] {
						queue = append(queue, dep)
					}
				}
				for _, m := range fm.Dependencies.MCPs {
					dep := "mcp:" + m
					if !visited[dep] {
						queue = append(queue, dep)
					}
				}
			}

		case "mcp":
			mcpPath := filepath.Join(r.root, "mcps", localName+".json")
			data, err := os.ReadFile(mcpPath)
			if err != nil {
				continue // skip missing
			}
			var config map[string]any
			if err := json.Unmarshal(data, &config); err != nil {
				continue
			}
			result.MCPs = append(result.MCPs, agent.MCPRef{
				Name:   localName,
				Config: config,
			})
		}
	}

	return result, nil
}
