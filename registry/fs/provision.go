package fs

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/LangSensei/emploke/kernel"
)

// Provision materializes all resolved capabilities for an agent into targetDir.
//   - Skills → targetDir/.github/skills/<name>/ (full directory copy)
//   - MCPs   → targetDir/.mcp.json (merged server config)
func (r *Registry) Provision(ctx context.Context, agent kernel.Agent, targetDir string) error {
	caps, err := r.Resolve(ctx, agent)
	if err != nil {
		return fmt.Errorf("provision: resolve: %w", err)
	}

	mcpServers := make(map[string]any)

	for _, cap := range caps {
		switch metaString(cap.Metadata, "type") {
		case "skill":
			src := filepath.Join(r.root, "skills", cap.Name)
			dst := filepath.Join(targetDir, ".github", "skills", cap.Name)
			if err := copyDir(src, dst); err != nil {
				return fmt.Errorf("provision: copy skill %q: %w", cap.Name, err)
			}
		case "mcp":
			server := make(map[string]any)
			for k, v := range cap.Metadata {
				if k == "type" {
					continue
				}
				server[k] = v
			}
			mcpServers[cap.Name] = server
		}
	}

	if len(mcpServers) > 0 {
		config := map[string]any{"mcpServers": mcpServers}
		data, err := json.MarshalIndent(config, "", "  ")
		if err != nil {
			return fmt.Errorf("provision: marshal mcp config: %w", err)
		}
		data = append(data, '\n')
		mcpPath := filepath.Join(targetDir, ".mcp.json")
		if err := os.WriteFile(mcpPath, data, 0644); err != nil {
			return fmt.Errorf("provision: write .mcp.json: %w", err)
		}
	}

	return nil
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
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
