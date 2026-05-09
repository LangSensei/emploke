# What we believe about agentic systems

> A short paper.
> If it resonates, you may have already had these thoughts.
> If it doesn't, that's fine — we're not arguing.

## What we've noticed

We've been watching the agentic-systems space for a couple of years now. There's a pattern that keeps surfacing for us. Frameworks are getting more elaborate — chains, graphs, executors, role-play protocols, output parsers, retry loops, prompt scaffolds, agent supervisors, multi-agent choreography — while at the same time, the models on the other end of the API are getting more capable. The two trends point in opposite directions. The harness is growing exactly where the model is closing the gap.

Once we noticed it, we couldn't stop seeing it.

## The bet we're making

Five years from now, the model on the other end of your API call will be doing things today's models can't. We don't know exactly what. We know enough to bet on the direction.

So we asked ourselves: what would a harness look like if you designed it for the model you'll have in five years, instead of the model you have today? Most of the things we currently scaffold around — chain composition, retry policies, output parsing, even most prompt engineering — those will be inside the model. The harness's job will shrink to the things the model genuinely cannot do for itself.

That shrinking is what we want to design for. Not what's missing in today's models, but what will still be missing when the models stop being today's.

## Three beliefs

Everything else in this paper unpacks three convictions.

### Agents are data, not code

When you build an agent inside a framework — a `LangChainAgent` subclass, a `CrewAI` role definition, an `AutoGen` configuration — that agent is locked to the framework that hosts it. Move it to a different framework and you rewrite it. The agent's identity lives in the framework's runtime, not in something portable.

We've come to believe this is backwards. An agent is a description: who I am, what I can do, what I depend on, how I prefer to behave. That description is *data*. It belongs in a markdown file with some frontmatter, the same way every other piece of human-readable specification belongs in a markdown file. You should be able to read it, edit it, version it, diff it, copy it from one machine to another, and — eventually — let an AI author its own.

The MetaAgents specification gets this right: agents are `AGENTS.md`, skills are `SKILL.md`, MCP servers are JSON configs. We adopt it without modification. What we add is the rest of the harness around it — and the conviction that the data layer is the *real* substrate, not the code that happens to read it.

### The harness should shrink as the model grows

Every line of harness code is, at some level, a bet that the model can't do that thing on its own. Each bet has a half-life.

In 2023 we wrote retry loops because models hallucinated structured output. In 2025 they don't, much. We wrote elaborate decomposition prompts because models couldn't plan. They can, mostly. We wrote tool-selection rubrics because models picked the wrong tool. They mostly pick the right one now. The bets keep losing.

We've come to think the right design discipline is to not place the bet in the first place. Every piece of harness should be load-bearing in a way that survives a smarter model. If a smarter model would obviate the code, the code shouldn't have been there. Better to start minimal and let the model fill in the gap than to build scaffolding the model will outgrow.

### The one thing the harness should grow is the AI's own ability to extend it

There's a corollary that becomes obvious once you accept the first two beliefs.

If agents are data, the AI can author them. If the harness shrinks toward a minimal substrate, the most important thing on top of that substrate is *what gets added by whom*. We don't think the answer is "the framework's plugin system." We think the answer is the AI itself.

The harness should expose one extension surface, deliberately and prominently: the place where new capabilities get added. And that surface should be designed first for the AI to use, with humans as a secondary consumer. This is the inverse of how plugin systems usually get designed.

This is the only piece of the harness we want to see *grow* over time. Everything else should be on a diet.

## What we keep small

If the harness shrinks, what's left? We think three things, and only three. Every other concern that currently lives in agent frameworks will eventually migrate into the model. These three won't, because they're concerns the model is structurally unable to own.

**Sandbox.** When the AI acts — writes a file, spawns a process, calls an external API — that action needs to happen inside a contained world. The container has to come from outside the model, because the model is the thing being contained. A model that sandboxes itself is a model that can be talked out of its own sandbox. Isolation is not a function of the AI; it's a property of the environment the AI runs in.

**Scheduling.** A single agent doesn't need a scheduler. It just runs. The moment you have a second agent, or one agent and a long-running task, or a task that fails and has to be replaced, you need an arbiter. The arbiter cannot be one of the agents. An agent that schedules itself is an agent that will deadlock the first time its premise turns out to be wrong, because it has no outside party to arbitrate the wrong-premise case. Scheduling is referee work, and referees don't play.

**Observability.** Every action the AI takes must leave a trace that something outside the AI can read. This isn't primarily for human supervision — it's for the *next* agent. Self-improvement starts here. An agent that can't see what the previous agent did has no way to build on it; an agent that can't see its own history has no way to iterate. We promise that the system's state is always inspectable from outside the model.

These three commitments are what the harness gives you that the model genuinely cannot give itself. Everything else — chains, graphs, prompt templates, output parsers, role assignments, retry policies, plan decomposition — is friction we expect to delete as models mature.

## What we keep open

There is one extension surface, and it deserves to be the centerpiece.

**Capability.** A capability is anything the AI can use to expand what it can do. In our world, that takes three forms today:

- **Skills** — markdown files (`SKILL.md`) that describe how to do a particular thing. The AI reads them; it doesn't execute them. They become part of how the AI thinks about the task in front of it.
- **MCPs** — JSON configs that describe a tool server the AI can talk to. The AI doesn't compile them; it picks them up at runtime.
- **Agents** — markdown files (`AGENTS.md`) that compose Skills and MCPs into a coherent role. An agent is a name, a description, and a list of dependencies. Nothing more.

All three are data. All three are git-diffable. All three can be authored by a human, by another AI, or — most interestingly — by the same AI that's about to use them.

The AI can read its own catalog of capabilities. It can author new ones. It can dispatch a task that produces a new capability and adds it to the catalog. It can compose existing capabilities into a new agent and dispatch *that*. The harness gives it the substrate; the AI gets to decide what the substrate accumulates over time.

This is the only piece of the system we deliberately design to grow. Everything else is a diet; this is the part that gets fed.

## What this opens up

Once you accept that the harness is small (sandbox + scheduling + observability) and the extension surface is one (capability), several things stop being problems and start being natural.

**Composition without a framework.** When agents declare their dependencies in their own frontmatter, and the substrate resolves those declarations against a flat catalog, you don't need a framework to express composition. There is no chain, no graph, no executor. The agent says what it needs; the substrate gives it what it asked for; the agent runs. Composition lives in the data, not in the code that happens to host the data on a particular machine.

**Multi-agent without orchestration code.** If two agents need to hand off work, they hand off through the file system or a task queue. Not through framework-level message passing. The handoff is just another action in someone's sandbox.

**Self-improvement, gradually.** The natural trajectory is: today the AI writes new Skills. Tomorrow it composes those Skills into new Agents. The day after, it dispatches Tasks whose explicit goal is to improve the catalog itself. The day after that, the AI is proposing changes to the harness — new primitives, new commitments, new conventions. Every step on this trajectory is supported by the same minimal substrate. Nothing in the system has to be re-architected to allow it; we just have to not put scaffolding in the way.

We're nowhere near the end of this trajectory yet. Today's models can author Skills usefully but not Agents reliably. Tomorrow's models will. We want to be in a position where the substrate is already ready for them.

## A reference implementation

We've been building one. It's called [emploke](https://github.com/LangSensei/emploke) — a pnpm monorepo of small TypeScript packages running locally, exposing a single HTTP server with a React dashboard. It implements the substrate this paper describes: per-project workspaces, a dependency-aware catalog of Skills / MCPs / Agents, isolated sandboxes for sessions and one-shot tasks, an observable state model.

There are pieces of emploke that don't appear in this paper. The codebase has a Runtime adapter interface (today it adapts the GitHub Copilot CLI; tomorrow it might adapt others) and a Repository abstraction (today it's a file system; tomorrow it might be a database). Those are real and important and we put care into them — but they're 2026 engineering, not paradigm. If the field consolidates onto a single agent runtime and a single storage backend, those abstractions disappear from emploke and nothing in this paper changes.

The implementation details live in the [architecture guide](./architecture.md). What's here is what we believe — the part we hope outlives the implementation.

## An invitation

If you've read this far and found yourself nodding, we'd like to know you exist. The agentic-systems space is loud right now and we've found it valuable to find quieter people who think along similar lines.

Two things you can do:

- Read the [emploke source](https://github.com/LangSensei/emploke). It's small (~10k lines of TypeScript). The paradigm here is concrete enough in code to argue with.
- Open an issue or a discussion on the repo. We're particularly interested in places where you think the paradigm breaks down — where a real-world need pushes back on the minimalism. We've made bets; we're curious which ones we'll regret.

This paper will evolve. The substrate will evolve. The AI will evolve, faster than either. We'd rather not bet alone.
