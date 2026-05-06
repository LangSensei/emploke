// Package fs implements [catalog.Registry] backed by the file system.
//
// Directory layout:
//
//	<root>/
//	├── agents/
//	│   └── <name>/
//	│       └── AGENT.md     ← frontmatter (type: agent, capabilities)
//	├── skills/
//	│   └── <name>/
//	│       └── SKILL.md     ← frontmatter (type: skill, dependencies)
//	└── mcps/
//	    └── <name>.json      ← native JSON (MCP server config)
//
// Agents and Skills are directories with a fixed entry file (AGENT.md / SKILL.md).
// MCPs are plain JSON files (flat, no directory).
//
// Import path:
//
//	import "github.com/LangSensei/emploke/catalog/fs"
package fs // import "github.com/LangSensei/emploke/catalog/fs"
