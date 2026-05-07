import type { AgentResolveResult } from "@emploke/catalog";

/**
 * A Provisioner prepares a workspace directory so an agent runtime can be
 * launched against it. Implementations are per-provider (Copilot, Claude,
 * OpenCode, …) because each provider expects a different directory layout
 * (`.github/skills/` vs `.claude/skills/`, etc.).
 *
 * The interface is intentionally narrow: a Provisioner takes a fully-resolved
 * dependency manifest plus a target directory, and writes the **environment**
 * — including the agent's persona file (e.g. `AGENTS.md`), skills, MCP
 * config, hooks, and git. It deliberately does NOT:
 *
 *   - Resolve names against a catalog (caller's job).
 *   - Compose or pass per-task instructions. The runtime feeds the per-task
 *     prompt directly to the CLI (e.g. `copilot -p "<task>"`); the
 *     provisioned `AGENTS.md` provides the persona/base context that the
 *     CLI auto-loads from the workdir. This split lets the same workdir
 *     serve many tasks against the same agent without re-provisioning.
 *   - Launch processes (runtime's job).
 */
export interface Provisioner {
  /** Provider identifier — `"copilot"`, `"claude"`, etc. */
  readonly name: string;

  /**
   * Compose the target directory. Idempotent: calling twice with the same
   * inputs produces the same files. Non-empty target directories are written
   * through (existing files may be overwritten); the caller decides whether
   * to clean up beforehand.
   */
  provision(params: ProvisionParams): Promise<void>;
}

export interface ProvisionParams {
  /**
   * Output of {@link import("@emploke/catalog").Catalog.resolveAgent}. The
   * provisioner accepts only an **agent** resolve result by design: an agent
   * is the unit of execution. Decoupling provisioner from catalog (taking
   * the resolved manifest, not the agent name) keeps the package independent
   * of any particular registry, makes tests trivial to fixture, and lets
   * callers transform the manifest before provisioning (e.g. inject extra
   * MCPs).
   */
  readonly resolveResult: AgentResolveResult;

  /**
   * Absolute path to the directory to populate. Created with `mkdir -p`
   * if missing.
   */
  readonly targetDir: string;
}
