---
name: git-pr
scope: emploke
description: "Git branch management and GitHub PR workflow using worktrees"
version: 1.0.0
---

# Git PR Skill

## Repository Setup

Bare clones are cached so subsequent runs re-fetch instead of re-cloning. The cache lives under `<workspace>/.repos/`, where `<workspace>` is `$EMPLOKE_WORKSPACE_DIR` (emploke's task/session runtime contract — always set per-run). When the script is invoked manually outside an emploke run (e.g. local debugging), `$EMPLOKE_WORKSPACE_DIR` is unset and the cache falls back to `./.repos/` (cwd-relative); `cd` into the workspace root first.

```bash
# --- workspace + repos-dir resolver (paste once at the top of the playbook) ---
project_root() {
  # `EMPLOKE_WORKSPACE_DIR` is emploke's runtime contract — always set inside
  # a task/session. `pwd` is the manual-invocation fallback.
  echo "${EMPLOKE_WORKSPACE_DIR:-$(pwd)}"
}

repos_dir() {
  echo "$(project_root)/.repos"
}

# --- per-repo bare clone ---
REPO_NAME="<repo-name>"  # e.g. emploke
REPO_URL="<repo-url>"    # e.g. https://github.com/LangSensei/emploke
REPOS_ROOT="$(repos_dir)"
REPO_DIR="$REPOS_ROOT/$REPO_NAME"

# First time: clone. Subsequent: fetch.
# All bare-repo commands use `git --git-dir="$REPO_DIR"` instead of `cd "$REPO_DIR"`
# so they keep working under `safe.bareRepository=explicit` (a default in newer
# git installs that rejects `git` invocations whose cwd is inside a bare clone).
if [ -d "$REPO_DIR" ]; then
  git --git-dir="$REPO_DIR" fetch --all --prune
else
  mkdir -p "$REPOS_ROOT"
  git clone --bare "$REPO_URL" "$REPO_DIR"
  git --git-dir="$REPO_DIR" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
  git --git-dir="$REPO_DIR" fetch --all --prune
fi
```

## Anti-pattern: do NOT put the worktree inside the bare clone

The worktree path argument MUST be `"$WORK_DIR/repo"` — an **absolute** path written from the workDir. Two failure modes to avoid:

1. **Relative path while cwd is inside the bare clone.** Writing `git worktree add -b "$BRANCH" repo origin/main` after `cd "$REPO_DIR"` creates the worktree at `<bare>/repo/`, **inside** the bare clone:
   - ✅ `git --git-dir="$REPO_DIR" worktree add -b "$BRANCH" "$WORK_DIR/repo" origin/main`
   - ❌ `cd "$REPO_DIR" && git worktree add -b "$BRANCH" repo origin/main`

2. **`cd` into the bare clone at all.** Newer git installs ship with `safe.bareRepository=explicit`, which rejects every subsequent `git` command whose cwd is inside a bare repo (including the very `git worktree add` you were trying to run). Using `git --git-dir="$REPO_DIR" …` from the workDir avoids this entirely:
   - ✅ `git --git-dir="$REPO_DIR" worktree add … "$WORK_DIR/repo" …`
   - ❌ `cd "$REPO_DIR"; git worktree add … "$WORK_DIR/repo" …`

The wrong forms have three consequences: they pollute the shared `.repos/` cache, they trip `safe.bareRepository=explicit` from any sibling directory, and the leaked files survive `git worktree remove` because they live inside the bare clone.

## Worktree Workflow

Each run gets its own worktree — isolated branch, shared .git objects, millisecond creation.

### Mode A: New Branch (default)

Use when starting a fresh PR from the default branch. Branch naming follows conventional commits with a descriptive slug (`<type>/<slug>`); the agent picks the slug based on what the PR is changing.

```bash
# Examples: chore/remove-deprecated-paths, feat/mcp-only-flag, fix/playwright-storage-path
BRANCH="<type>/<slug>"
WORK_DIR="$(pwd)"  # workDir

git --git-dir="$REPO_DIR" worktree add -b "$BRANCH" "$WORK_DIR/repo" origin/main
cd "$WORK_DIR/repo"
# ... make changes ...
```

### Mode B: Resume Existing Branch

Use when the brief specifies an existing branch (e.g. fixing review comments on an open PR).

```bash
EXISTING_BRANCH="<branch-from-brief>"  # e.g. feat/mcp-only-flag
WORK_DIR="$(pwd)"

git --git-dir="$REPO_DIR" fetch origin
git --git-dir="$REPO_DIR" worktree add "$WORK_DIR/repo" "origin/$EXISTING_BRANCH"
cd "$WORK_DIR/repo"
git checkout -B "$EXISTING_BRANCH" "origin/$EXISTING_BRANCH"

# ... make changes, commit, push ...
```

**How to decide:** If the brief contains a branch name or PR reference with an existing branch, use Mode B. Otherwise use Mode A.

### Mode C: Read-Only

Use when only reading repo code — no changes, no commits, no PR.

```bash
WORK_DIR="$(pwd)"

git --git-dir="$REPO_DIR" worktree add "$WORK_DIR/repo" origin/main --detach
cd "$WORK_DIR/repo"
# ... read files, grep, explore ...
# Do NOT commit or push.

# Cleanup at seal:
git --git-dir="$REPO_DIR" worktree remove "$WORK_DIR/repo" --force
```

**How to decide:** If the run only needs to read source code for analysis (no writes, no PR), use Mode C.

## Worktree Cleanup

**Mandatory at seal time.** After push (Mode A/B) or after reading (Mode C), clean up. Agents using this skill must clean up in their playbook's seal/delivery phase.

```bash
git --git-dir="$REPO_DIR" worktree remove "$WORK_DIR/repo" --force
```

## Commit & Push

```bash
git add -A
git commit -m "feat: description"
git push origin HEAD
```

## Open PR

```bash
gh pr create --title "feat: ..." --body "..." --base main
```

## Conventional Commits

Format: `<type>: <description>`

Types:
- `feat:` — New feature
- `fix:` — Bug fix
- `refactor:` — Code restructuring
- `docs:` — Documentation only
- `test:` — Tests
- `chore:` — Maintenance

## PR Description Template

```markdown
## What
Brief description of the change.

## Why
Context and motivation.

## Changes
- file1: description
- file2: description

## How to Test
Steps to verify.
```

## Rules

- **Never push directly to the default branch** — always open a PR
- **One logical change per commit**
- **PR title follows conventional commits**
- **Branch name is a descriptive `<type>/<slug>`** — no fixed prefix; the slug describes the change (`chore/remove-deprecated-paths`, not `op/<opaque-id>`)
- **Bare clone goes to the resolved repos dir** (`$(repos_dir)`), never into the workDir directly
- **Never `cd` into the bare clone.** All bare-repo commands use `git --git-dir="$REPO_DIR" …`. See "Anti-pattern: do NOT put the worktree inside the bare clone" above.
- **Worktree path is always `"$WORK_DIR/repo"`** — absolute, written from the workDir; never a bare relative `repo`.
- **Always clean up worktree at seal** — do not leave orphaned worktrees
