// Package fs implements [registry.Registry] backed by the file system.
//
// Directory layout:
//
//	<root>/
//	├── agents/
//	│   └── <name>.md        ← frontmatter (type: agent, capabilities)
//	├── skills/
//	│   └── <name>.md        ← frontmatter (type: skill, dependencies)
//	└── mcps/
//	    └── <name>.json      ← native JSON (MCP server config)
//
// Agents and Skills use YAML frontmatter in markdown files.
// MCPs use plain JSON files.
//
// Import path:
//
//	import "github.com/LangSensei/emploke/registry/fs"
package fs // import "github.com/LangSensei/emploke/registry/fs"
