# Local agent — minimal template

Use this as the frame when you create a new local agent (decision-tree step 3).

## File location

```
<workspace>/local-agents/<name>/AGENTS.md
```

`<workspace>` is `$EMPLOKE_WORKSPACE_DIR` (emploke's task/session runtime contract injects it into every spawned process).

`<name>` is your kebab-case role slug.

## Frontmatter (mandatory)

```yaml
---
name: <name>                      # MUST equal the directory basename
scope: local                      # convention: 'local' for pilot-created agents
description: "<one-line: what this agent does>"
version: 1.0.0                    # bump on edits
---
```

**Do NOT include `dependencies.skills: [emploke/cli]`.** Subagents don't orchestrate. The pilot is the only one with that skill.

If your local agent legitimately needs an MCP (e.g. web search), declare it:

```yaml
dependencies:
  mcps:
    - "https://github.com/LangSensei/emploke-marketplace/tree/main/mcps/<file>.json"
```

## Body sections (recommended structure)

```markdown
# <Role Name>

## Mission
<One paragraph describing what this agent does and what it does NOT do.>

## Inputs
<What the agent expects in task instructions: format, fields, constraints.>

## Output format
<Exactly what shape the agent's output should take. Strict.>

## Process
<Step-by-step what the agent should do internally.>

## Constraints
- <hard rules: things the agent MUST never do>
- ...

## Examples
### Input → Output example 1
<concrete example>

### Input → Output example 2
<another example showing variation>
```

## Install command

```sh
NAME="<name>"
DIR="$EMPLOKE_WORKSPACE_DIR/local-agents/$NAME"
emploke catalog agent install --file "$DIR" --json
```

The CLI returns the installed entry; verify the FQN is `local/$NAME`:

```sh
emploke catalog agent show "local/$NAME" --json | jq '.agent.fqn, .status'
```

If `.status != "ok"`, see `references/error-codes.md` in the `emploke/cli` skill — usually missing prereqs or dependency issues.

## Iterating

`file:` origins are mutable. To revise the agent:

1. Edit `<workspace>/local-agents/<name>/AGENTS.md`.
2. Bump `version:` in the frontmatter (semver).
3. Re-install:
   ```sh
   emploke catalog agent install --file "$DIR" --json
   ```
4. Probe again with a fresh probe task.
5. If the probe passes, update `.pilot/hires.md` with the new version's outcome.

## Retirement

When you're done with a local agent (mission ended, replaced by v2, etc.):

```sh
emploke catalog agent disable "local/$NAME"
emploke catalog agent rm "local/$NAME"
mv "<workspace>/local-agents/$NAME" "<workspace>/local-agents/_retired/$NAME-$(date +%Y%m%d)/"
```

Append to `.pilot/decisions.log`: `RETIRE | local/$NAME | <reason>`.
