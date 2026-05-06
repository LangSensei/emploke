package fs

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// frontmatter represents parsed YAML frontmatter from a .md file.
type frontmatter struct {
	Name         string     `json:"name"`
	Version      string     `json:"version"`
	Type         string     `json:"type"` // "agent" or "skill"
	Capabilities *depsBlock `json:"capabilities,omitempty"`
	Dependencies *depsBlock `json:"dependencies,omitempty"`
}

// depsBlock represents capabilities (on Agent) or dependencies (on Skill).
type depsBlock struct {
	Skills []string `json:"skills"`
	MCPs   []string `json:"mcps"`
}

// parseFrontmatter extracts YAML frontmatter from a markdown file.
// Returns the frontmatter and the body (everything after the closing ---).
func parseFrontmatter(path string) (frontmatter, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return frontmatter{}, "", err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	var fm frontmatter
	var fmLines []string
	var bodyLines []string
	inFM := false
	fmDone := false

	for scanner.Scan() {
		line := scanner.Text()
		if !inFM && !fmDone && strings.TrimSpace(line) == "---" {
			inFM = true
			continue
		}
		if inFM && strings.TrimSpace(line) == "---" {
			inFM = false
			fmDone = true
			continue
		}
		if inFM {
			fmLines = append(fmLines, line)
		} else if fmDone {
			bodyLines = append(bodyLines, line)
		}
	}

	if err := scanner.Err(); err != nil {
		return frontmatter{}, "", err
	}

	// Parse frontmatter as simple YAML (we use a minimal parser to avoid deps)
	fm = parseSimpleYAML(fmLines)

	body := strings.TrimSpace(strings.Join(bodyLines, "\n"))
	return fm, body, nil
}

// parseSimpleYAML parses our subset of YAML frontmatter without external deps.
// Supports: name, version, type (strings), capabilities/dependencies (nested skills/mcps arrays).
func parseSimpleYAML(lines []string) frontmatter {
	var fm frontmatter
	var currentBlock *depsBlock
	inArray := ""

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Top-level key: value
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") && strings.Contains(line, ":") {
			parts := strings.SplitN(line, ":", 2)
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			val = strings.Trim(val, "\"'")

			switch key {
			case "name":
				fm.Name = val
			case "version":
				fm.Version = val
			case "type":
				fm.Type = val
			case "capabilities":
				fm.Capabilities = &depsBlock{}
				currentBlock = fm.Capabilities
			case "dependencies":
				fm.Dependencies = &depsBlock{}
				currentBlock = fm.Dependencies
			}
			inArray = ""
			continue
		}

		// Nested under capabilities/dependencies
		if currentBlock != nil {
			if strings.Contains(trimmed, "skills:") {
				inArray = "skills"
				// Check inline array: skills: [a, b]
				if items := parseInlineArray(trimmed); items != nil {
					currentBlock.Skills = items
					inArray = ""
				}
				continue
			}
			if strings.Contains(trimmed, "mcps:") {
				inArray = "mcps"
				if items := parseInlineArray(trimmed); items != nil {
					currentBlock.MCPs = items
					inArray = ""
				}
				continue
			}
			// Array item: - value
			if strings.HasPrefix(trimmed, "- ") {
				item := strings.TrimSpace(strings.TrimPrefix(trimmed, "- "))
				item = strings.Trim(item, "\"'")
				switch inArray {
				case "skills":
					currentBlock.Skills = append(currentBlock.Skills, item)
				case "mcps":
					currentBlock.MCPs = append(currentBlock.MCPs, item)
				}
			}
		}
	}
	return fm
}

// parseInlineArray parses "key: [a, b, c]" and returns the items.
// Returns nil if not an inline array format.
func parseInlineArray(line string) []string {
	idx := strings.Index(line, "[")
	if idx < 0 {
		return nil
	}
	end := strings.Index(line, "]")
	if end < 0 {
		return nil
	}
	inner := line[idx+1 : end]
	if strings.TrimSpace(inner) == "" {
		return []string{}
	}
	parts := strings.Split(inner, ",")
	var result []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		p = strings.Trim(p, "\"'")
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

// writeFrontmatter writes a .md file with frontmatter and body.
func writeFrontmatter(path string, fm frontmatter, body string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString(fmt.Sprintf("name: %s\n", fm.Name))
	if fm.Version != "" {
		b.WriteString(fmt.Sprintf("version: \"%s\"\n", fm.Version))
	}
	b.WriteString(fmt.Sprintf("type: %s\n", fm.Type))

	if fm.Capabilities != nil {
		b.WriteString("capabilities:\n")
		writeDepsBlock(&b, fm.Capabilities)
	}
	if fm.Dependencies != nil {
		b.WriteString("dependencies:\n")
		writeDepsBlock(&b, fm.Dependencies)
	}

	b.WriteString("---\n")
	if body != "" {
		b.WriteString("\n")
		b.WriteString(body)
		b.WriteString("\n")
	}

	return os.WriteFile(path, []byte(b.String()), 0644)
}

func writeDepsBlock(b *strings.Builder, d *depsBlock) {
	b.WriteString(fmt.Sprintf("  skills: [%s]\n", strings.Join(d.Skills, ", ")))
	b.WriteString(fmt.Sprintf("  mcps: [%s]\n", strings.Join(d.MCPs, ", ")))
}

// readMCPConfig reads a .json MCP configuration file.
func readMCPConfig(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var config map[string]any
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("parse %s: %w", filepath.Base(path), err)
	}
	return config, nil
}

// writeMCPConfig writes a .json MCP configuration file.
func writeMCPConfig(path string, config map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0644)
}

// listDir returns file base names (without extension) in a directory.
func listDir(dir, ext string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if ext != "" && filepath.Ext(e.Name()) != ext {
			continue
		}
		names = append(names, strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())))
	}
	return names, nil
}

// listSubdirs returns subdirectory names in a directory.
func listSubdirs(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	return names, nil
}
