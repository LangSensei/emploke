# Hiring — decision tree

When a mission step needs an agent, walk this tree top-down. Stop at the first option that fits.

```
need an agent for work X
  │
  ├─→ 1. REUSE: any installed agent matches?
  │        emploke catalog agent list --json
  │        check .pilot/hires.md for performance history
  │        ┌─→ YES, known-good fit → DISPATCH (done)
  │        └─→ NO, or nothing rated highly → continue
  │
  ├─→ 2. INSTALL FROM MARKETPLACE: relevant agent exists upstream?
  │        browse: https://github.com/LangSensei/emploke-marketplace/tree/main/agents/
  │        OR ask the user "is there an agent for X you know about?"
  │        ┌─→ YES → INSTALL via emploke catalog agent install --url <url> | --file <path>
  │        │         then PROBE (see probe-tasks.md)
  │        │         on probe success → DISPATCH the real work
  │        └─→ NO → continue
  │
  └─→ 3. CREATE LOCAL: write a new agent definition
           consult agency-role-reference skill's references/index.md
             pick the closest abstract role; curl the upstream template
           draft via template-base.md + writing-good-agent-prompts.md
             (use the upstream role template as a STARTING POINT, specialize for THIS mission)
           install via file:// origin
           PROBE (see probe-tasks.md)
           on probe success → DISPATCH
```

## Why this order

- **Reuse is cheapest** (no install, performance is known)
- **Install is medium** (one network round-trip + a probe; broader coverage than local)
- **Create is most expensive** (drafting + iteration + probe; only when nothing else fits)

## Each step in detail

### Step 1: Reuse

```sh
emploke catalog agent list --json | jq '[.[] | {fqn: .agent.fqn, status: .status}]'
```

Check `.pilot/hires.md` for each candidate's recent performance. If an agent has succeeded on similar work in the past 30 days with quality you trusted, prefer it.

**Reuse criteria:**
- Domain match (the agent is in or adjacent to the work's domain)
- Status `ok` (not blocked)
- Recent performance ≥ a threshold you've calibrated for this mission

Don't reuse agents with red flags in `.pilot/hires.md` ("invented data", "missed obvious requirement", etc.).

### Step 2: Install from marketplace

The marketplace is the broad library of community-maintained agents. Search:

- Browse the GitHub repo's `agents/` directory
- Look for agents whose `description` matches the work
- Read the agent's `AGENTS.md` body to confirm capability

Install via:

```sh
ORIGIN="https://github.com/LangSensei/emploke-marketplace/tree/main/agents/<name>"
emploke catalog agent install --url "$ORIGIN" --json
```

Then handle the install per `emploke/cli` skill's "Install an agent and make sure it's ready to dispatch" workflow (handle blocked-state branches, ack prereqs if appropriate, etc.).

**After successful install, ALWAYS probe before trusting with mission work.** A marketplace agent might be well-described but mediocre at the specific work you need.

### Step 3: Create local

You're here because:
- No installed agent fits
- No marketplace agent fits (or they all need adaptation)
- You're sure you need a specialist that doesn't exist

Process:

1. Pick a name. Use a kebab-case slug describing the role precisely. **Don't be generic.** `report-writer` is too vague; `weekly-status-report-writer` is better; `q2-saas-launch-status-writer` is overfit. Aim for the middle.
2. Pick a scope. Use `local` (or your workspace's name) — anything that's not a registered marketplace scope. The FQN will be `local/<name>`.
3. **Consult the agency role library** (`agency-role-reference` skill) for a starting template:

   ```sh
   # Read the index (LLM resolves <SKILL_DIR> from runtime context — see the
   # agency-role-reference skill body, plus the same convention used in `sop`
   # and `scientific-method` skills)
   cat <SKILL_DIR>/references/index.md

   # Pick the closest abstract role; fetch the upstream template body (one-shot, no install)
   curl -sL <upstream-url-from-the-index> > /tmp/role.md
   ```

   The library has ~185 abstract role templates across engineering, design, product, marketing, sales, support, testing, game development, vertical specialists, and more. **These are starting points, not finished hires** — see the skill's `SKILL.md` for the full "specialize, don't copy" contract.

   If the index has no good match, skip this step and go to draft-from-scratch via the references below.

4. Draft the AGENTS.md using `template-base.md` as the frame and `writing-good-agent-prompts.md` for the body content. When step 3 yielded a template, mine it for: mission framing, critical rules, workflow phases, and success metrics — then **specialize each section for your mission** (your stack, your conventions, your acceptance criteria). Drop sections that don't apply.
5. Install via `file://` origin (see template-base.md for the install command).
6. **Probe** before adding to `hires.md`.
7. Iterate the agent file based on probe results — `file://` origins are mutable; you can edit and re-install.

## When not to create a new agent

- **Existing agent does it 80% right.** Don't create v2 yet — write better instructions in the dispatch and see if that closes the gap. Only create v2 if instruction-tuning isn't enough.
- **Work is one-off.** Creating an agent is overhead. If you'll dispatch this kind of work once, give the work to your closest existing fit with detailed instructions.
- **You're under time pressure.** Creating an agent + probing takes time. If the user needs an answer in the next 10 minutes, use the closest existing fit even if imperfect.

## When to retire an agent

- Persistent failure pattern (3+ failures in `hires.md` for similar work)
- Made up data (single instance is enough — trust is binary)
- A v2 you created supersedes it
- Mission ended and the agent doesn't fit the next mission

To retire:

```sh
emploke catalog agent disable "$FQN"             # soft-disable first; keeps state
# After confirming nothing depends on it:
emploke catalog agent rm "$FQN"                  # hard remove
```

Move retired local agent definitions:

```sh
mv "<workspace>/local-agents/$NAME" "<workspace>/local-agents/_retired/$NAME-$(date +%Y%m%d)/"
```

Append to `.pilot/decisions.log`: `RETIRE | <fqn> | <reason>`.
