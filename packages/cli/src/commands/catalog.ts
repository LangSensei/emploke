/**
 * `emploke catalog …` — wraps the workspace-scoped catalog HTTP surface.
 *
 * Three resource families behind one parent command:
 *  - `skill {list,resolve,show,install,update,patch,rm}` (7)
 *  - `agent {list,resolve,show,install,update,patch,rm}` (7)
 *  - `mcp   {list,show,install,update,rm}` (5)
 *
 * Plus `catalog overview` for the per-workspace counts. Total: 20
 * functions exported here, mapping 1:1 to the manifest entries.
 */

import { readFile } from "node:fs/promises";
import { makeClient, resolveWorkspace } from "../connect.js";
import { formatError, formatJson, formatRecord, formatTable, pickFormat } from "../output.js";
import type { CommandResult } from "../result.js";

interface CommonFlags {
  readonly server?: string;
  readonly home?: string;
  readonly workspace?: string;
  readonly output?: string;
  readonly json?: boolean;
}

/**
 * Mutually-exclusive `--url <value>` / `--file <path>` flag pair shared
 * by every catalog install / resolve command. The user picks ONE; the
 * CLI assembles the canonical wire origin via {@link buildInstallOrigin}.
 */
interface InstallSourceFlags {
  readonly url?: string;
  readonly file?: string;
}

/**
 * Build the canonical wire origin from the CLI's `--url` / `--file` flags.
 *
 * Exactly one flag must be set. Returns either:
 *  - `{ origin }` — ready for the wire payload, OR
 *  - `{ error }`  — a human-readable message for stderr (exit code 2).
 *
 * Rules:
 *  - `--url <value>` is pass-through (the server's `parseOrigin` picks the
 *    fetcher from the URL grammar; today only `https://github.com/...` is
 *    accepted, with `parseOrigin` returning a clear "unsupported scheme"
 *    error otherwise).
 *  - `--file <path>` prepends `file:` if not already prefixed (tolerates
 *    paste of `file:/abs/x`).
 *  - `--url file:...` is rejected — picking URL with a `file:` URI is a
 *    misuse. Suggest `--file` instead.
 *  - Neither flag, both flags → usage error listing both.
 *  - Whitespace-only flag values are treated as missing.
 *
 * Mirror lives in `packages/dashboard/src/api/catalog.ts`
 * (`buildOriginFromSource`) so the same shape is rejected at both
 * client-input boundaries.
 */
function buildInstallOrigin(opts: InstallSourceFlags): { origin: string } | { error: string } {
  const url = typeof opts.url === "string" ? opts.url.trim() : "";
  const file = typeof opts.file === "string" ? opts.file.trim() : "";
  if (url === "" && file === "") {
    return { error: "must provide --url <value> or --file <path>" };
  }
  if (url !== "" && file !== "") {
    return { error: "cannot provide both --url and --file; pick one" };
  }
  if (url !== "") {
    if (url.startsWith("file:")) {
      return { error: 'URL source cannot be a "file:" URI; use --file <path> instead' };
    }
    return { origin: url };
  }
  return { origin: file.startsWith("file:") ? file : `file:${file}` };
}

// ─── overview ──────────────────────────────────────────────────────────
export type CatalogOverviewOpts = CommonFlags;

export async function catalogOverview(opts: CatalogOverviewOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const ov = await client.call("catalog.overview", { params: { id } });
    const fmt = pickFormat(opts, "table");
    const stdout = fmt === "json" ? formatJson(ov) : formatRecord({ ...ov.counts });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── shared helpers ────────────────────────────────────────────────────

/**
 * Resolve the `--content` payload. Precedence:
 *  1. `--content "literal"`  — inline string
 *  2. `--content-file <path>` — read the file as utf8
 * Errors when both or neither is supplied.
 */
async function readContentPayload(opts: {
  content?: string;
  contentFile?: string;
}): Promise<string | { error: string }> {
  const both = opts.content !== undefined && opts.contentFile !== undefined;
  const neither = opts.content === undefined && opts.contentFile === undefined;
  if (both) return { error: "pass exactly one of --content or --content-file" };
  if (neither) return { error: "missing --content <text> or --content-file <path>" };
  if (opts.content !== undefined) return opts.content;
  try {
    return await readFile(opts.contentFile as string, "utf8");
  } catch (err) {
    return {
      error: `--content-file read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Resolve the `--metadata` JSON object. Inline `--metadata '{...}'` or
 * `--metadata-file <path>`. Returns the parsed object; errors when not
 * a JSON object (arrays / scalars are rejected so the route never sees
 * a malformed PATCH body).
 */
async function readMetadataPayload(opts: {
  metadata?: string;
  metadataFile?: string;
}): Promise<Record<string, unknown> | { error: string }> {
  const both = opts.metadata !== undefined && opts.metadataFile !== undefined;
  const neither = opts.metadata === undefined && opts.metadataFile === undefined;
  if (both) return { error: "pass exactly one of --metadata or --metadata-file" };
  if (neither) return { error: "missing --metadata <json> or --metadata-file <path>" };
  let raw: string;
  if (opts.metadata !== undefined) {
    raw = opts.metadata;
  } else {
    try {
      raw = await readFile(opts.metadataFile as string, "utf8");
    } catch (err) {
      return {
        error: `--metadata-file read failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      error: `--metadata JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "--metadata must be a JSON object" };
  }
  return parsed as Record<string, unknown>;
}

// ─── skills ────────────────────────────────────────────────────────────

export type CatalogSkillListOpts = CommonFlags;

export async function catalogSkillList(opts: CatalogSkillListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const list = await client.call("catalog.skills.list", { params: { id } });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["fqn", "origin", "status"],
        list.map((entry) => [entry.skill.fqn, entry.skill.origin, entry.status]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillResolveOpts extends CommonFlags, InstallSourceFlags {}

export async function catalogSkillResolve(opts: CatalogSkillResolveOpts): Promise<CommandResult> {
  const built = buildInstallOrigin(opts);
  if ("error" in built) {
    return { exitCode: 2, stderr: `${built.error}\n` };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const plan = await client.call("catalog.skills.resolve", {
      params: { id },
      body: { origin: built.origin },
    });
    return { exitCode: 0, stdout: formatJson(plan) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillShowOpts extends CommonFlags {
  readonly name: string;
  /** When true, fetch the SKILL.md anchor bytes via the dedicated endpoint instead of the entry. */
  readonly anchor?: boolean;
}

export async function catalogSkillShow(opts: CatalogSkillShowOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "skill name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    if (opts.anchor === true) {
      // Dedicated anchor endpoint (issue #122) — returns just the
      // SKILL.md bytes without the surrounding entry metadata. Use the
      // raw bytes as stdout so callers can `>` pipe them straight to a
      // file.
      const res = await client.call("catalog.skills.anchor", {
        params: { id, name: opts.name },
      });
      return { exitCode: 0, stdout: res.content };
    }
    const skill = await client.call("catalog.skills.get", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(skill) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillInstallOpts extends CommonFlags, InstallSourceFlags {}

export async function catalogSkillInstall(opts: CatalogSkillInstallOpts): Promise<CommandResult> {
  const built = buildInstallOrigin(opts);
  if ("error" in built) {
    return { exitCode: 2, stderr: `${built.error}\n` };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const result = await client.call("catalog.skills.install", {
      params: { id },
      body: { origin: built.origin },
    });
    return { exitCode: 0, stdout: formatJson(result) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillUpdateOpts extends CommonFlags {
  readonly name: string;
  readonly content?: string;
  readonly contentFile?: string;
}

export async function catalogSkillUpdate(opts: CatalogSkillUpdateOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "skill name is required\n" };
  }
  const content = await readContentPayload(opts);
  if (typeof content !== "string") return { exitCode: 2, stderr: `${content.error}\n` };
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const skill = await client.call("catalog.skills.updateContent", {
      params: { id, name: opts.name },
      body: { content },
    });
    return { exitCode: 0, stdout: formatJson(skill) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillPatchOpts extends CommonFlags {
  readonly name: string;
  readonly metadata?: string;
  readonly metadataFile?: string;
}

export async function catalogSkillPatch(opts: CatalogSkillPatchOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "skill name is required\n" };
  }
  const metadata = await readMetadataPayload(opts);
  if ("error" in metadata) return { exitCode: 2, stderr: `${metadata.error}\n` };
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const skill = await client.call("catalog.skills.updateMetadata", {
      params: { id, name: opts.name },
      body: metadata,
    });
    return { exitCode: 0, stdout: formatJson(skill) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillRmOpts extends CommonFlags {
  readonly name: string;
}

export async function catalogSkillRm(opts: CatalogSkillRmOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "skill name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    await client.call("catalog.skills.delete", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: `skill ${opts.name} removed\n` };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillSyncResolveOpts extends CommonFlags {
  readonly name: string;
}

/**
 * Re-resolve an installed skill against its upstream origin and return
 * a fresh install plan (without applying it). The plan is one-shot —
 * pass `result.planToken` to {@link catalogSkillSync} within 5 minutes
 * to apply.
 */
export async function catalogSkillSyncResolve(
  opts: CatalogSkillSyncResolveOpts,
): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "skill name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const plan = await client.call("catalog.skills.syncResolve", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(plan) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillSyncOpts extends CommonFlags {
  readonly name: string;
  readonly planToken: string;
}

/**
 * Apply a previously-previewed sync plan. `planToken` MUST come from a
 * recent `catalog.skills.syncResolve` response — the server enforces a
 * single-use, 5-minute TTL on tokens to keep the apply step replaying
 * the exact preview-time plan.
 */
export async function catalogSkillSync(opts: CatalogSkillSyncOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "skill name is required\n" };
  }
  if (typeof opts.planToken !== "string" || opts.planToken.trim() === "") {
    return { exitCode: 2, stderr: "--plan-token is required (mint with `skill sync-resolve`)\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const result = await client.call("catalog.skills.sync", {
      params: { id, name: opts.name },
      body: { planToken: opts.planToken },
    });
    return { exitCode: 0, stdout: formatJson(result) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillAckPrereqsOpts extends CommonFlags {
  readonly name: string;
}

/**
 * Mark a skill's `prereqs` as acknowledged for this installation. The
 * status flips out of `blocked` (when `needsPrereqsAck` was the only
 * cause) and tasks that depend on it can be dispatched.
 */
export async function catalogSkillAckPrereqs(
  opts: CatalogSkillAckPrereqsOpts,
): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "skill name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const skill = await client.call("catalog.skills.acknowledgePrereqs", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(skill) };
  } catch (err) {
    return formatError(err);
  }
}

// ─── agents ────────────────────────────────────────────────────────────

export type CatalogAgentListOpts = CommonFlags;

export async function catalogAgentList(opts: CatalogAgentListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const list = await client.call("catalog.agents.list", { params: { id } });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["fqn", "origin", "status"],
        list.map((entry) => [entry.agent.fqn, entry.agent.origin, entry.status]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentResolveOpts extends CommonFlags, InstallSourceFlags {}

export async function catalogAgentResolve(opts: CatalogAgentResolveOpts): Promise<CommandResult> {
  const built = buildInstallOrigin(opts);
  if ("error" in built) {
    return { exitCode: 2, stderr: `${built.error}\n` };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const plan = await client.call("catalog.agents.resolve", {
      params: { id },
      body: { origin: built.origin },
    });
    return { exitCode: 0, stdout: formatJson(plan) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentShowOpts extends CommonFlags {
  readonly name: string;
  /** When true, fetch the AGENTS.md anchor bytes via the dedicated endpoint instead of the entry. */
  readonly anchor?: boolean;
}

export async function catalogAgentShow(opts: CatalogAgentShowOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    if (opts.anchor === true) {
      // Dedicated anchor endpoint (issue #122). Same rationale as
      // `catalogSkillShow` above.
      const res = await client.call("catalog.agents.anchor", {
        params: { id, name: opts.name },
      });
      return { exitCode: 0, stdout: res.content };
    }
    const agent = await client.call("catalog.agents.get", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(agent) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentInstallOpts extends CommonFlags, InstallSourceFlags {}

export async function catalogAgentInstall(opts: CatalogAgentInstallOpts): Promise<CommandResult> {
  const built = buildInstallOrigin(opts);
  if ("error" in built) {
    return { exitCode: 2, stderr: `${built.error}\n` };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const result = await client.call("catalog.agents.install", {
      params: { id },
      body: { origin: built.origin },
    });
    return { exitCode: 0, stdout: formatJson(result) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentUpdateOpts extends CommonFlags {
  readonly name: string;
  readonly content?: string;
  readonly contentFile?: string;
}

export async function catalogAgentUpdate(opts: CatalogAgentUpdateOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  const content = await readContentPayload(opts);
  if (typeof content !== "string") return { exitCode: 2, stderr: `${content.error}\n` };
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const agent = await client.call("catalog.agents.updateContent", {
      params: { id, name: opts.name },
      body: { content },
    });
    return { exitCode: 0, stdout: formatJson(agent) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentPatchOpts extends CommonFlags {
  readonly name: string;
  readonly metadata?: string;
  readonly metadataFile?: string;
}

export async function catalogAgentPatch(opts: CatalogAgentPatchOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  const metadata = await readMetadataPayload(opts);
  if ("error" in metadata) return { exitCode: 2, stderr: `${metadata.error}\n` };
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const agent = await client.call("catalog.agents.updateMetadata", {
      params: { id, name: opts.name },
      body: metadata,
    });
    return { exitCode: 0, stdout: formatJson(agent) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentRmOpts extends CommonFlags {
  readonly name: string;
}

export async function catalogAgentRm(opts: CatalogAgentRmOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    await client.call("catalog.agents.delete", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: `agent ${opts.name} removed\n` };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentSyncResolveOpts extends CommonFlags {
  readonly name: string;
}

/** Mirror of {@link catalogSkillSyncResolve} for agents. */
export async function catalogAgentSyncResolve(
  opts: CatalogAgentSyncResolveOpts,
): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const plan = await client.call("catalog.agents.syncResolve", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(plan) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentSyncOpts extends CommonFlags {
  readonly name: string;
  readonly planToken: string;
}

/** Mirror of {@link catalogSkillSync} for agents. */
export async function catalogAgentSync(opts: CatalogAgentSyncOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  if (typeof opts.planToken !== "string" || opts.planToken.trim() === "") {
    return { exitCode: 2, stderr: "--plan-token is required (mint with `agent sync-resolve`)\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const result = await client.call("catalog.agents.sync", {
      params: { id, name: opts.name },
      body: { planToken: opts.planToken },
    });
    return { exitCode: 0, stdout: formatJson(result) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentAckPrereqsOpts extends CommonFlags {
  readonly name: string;
}

/** Mirror of {@link catalogSkillAckPrereqs} for agents. */
export async function catalogAgentAckPrereqs(
  opts: CatalogAgentAckPrereqsOpts,
): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const agent = await client.call("catalog.agents.acknowledgePrereqs", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(agent) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentEnableOpts extends CommonFlags {
  readonly name: string;
}

/**
 * Re-enable a previously-disabled agent. Unlike skills/MCPs, agents
 * are user-toggleable; this lifts the `disabledByUser` block and lets
 * tasks dispatch against the agent again.
 */
export async function catalogAgentEnable(opts: CatalogAgentEnableOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const agent = await client.call("catalog.agents.enable", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(agent) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentDisableOpts extends CommonFlags {
  readonly name: string;
}

/**
 * Disable an agent. Pending tasks still drain; new dispatches fail
 * with `EntryNotReadyError` (`disabledByUser`). Re-enable via
 * {@link catalogAgentEnable}.
 */
export async function catalogAgentDisable(opts: CatalogAgentDisableOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const agent = await client.call("catalog.agents.disable", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(agent) };
  } catch (err) {
    return formatError(err);
  }
}

// ─── mcps ──────────────────────────────────────────────────────────────

export type CatalogMcpListOpts = CommonFlags;

export async function catalogMcpList(opts: CatalogMcpListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const list = await client.call("catalog.mcps.list", { params: { id } });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["fqn", "origin", "mutable", "installedAt"],
        list.map((m) => [m.fqn, m.origin, String(m.mutable), m.installedAt]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpShowOpts extends CommonFlags {
  readonly fqn: string;
}

export async function catalogMcpShow(opts: CatalogMcpShowOpts): Promise<CommandResult> {
  if (typeof opts.fqn !== "string" || opts.fqn.trim() === "") {
    return { exitCode: 2, stderr: "mcp fqn is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const mcp = await client.call("catalog.mcps.get", {
      params: { id, name: opts.fqn },
    });
    return { exitCode: 0, stdout: formatJson(mcp) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpInstallOpts extends CommonFlags, InstallSourceFlags {}

export async function catalogMcpInstall(opts: CatalogMcpInstallOpts): Promise<CommandResult> {
  const built = buildInstallOrigin(opts);
  if ("error" in built) {
    return { exitCode: 2, stderr: `${built.error}\n` };
  }
  // Server contract is `{ origin }` only — the fqn is derived from
  // the fetched JSON's `_meta.name` at install time, not from the
  // request body (see `validateMcpInstallInput`). The defense-in-depth
  // test at `cli/test/api-client.test.ts:249` pins this contract;
  // sending an extra `name` field would violate it.
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const result = await client.call("catalog.mcps.install", {
      params: { id },
      body: { origin: built.origin },
    });
    return { exitCode: 0, stdout: formatJson(result) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpUpdateOpts extends CommonFlags {
  readonly fqn: string;
  readonly content?: string;
  readonly contentFile?: string;
}

export async function catalogMcpUpdate(opts: CatalogMcpUpdateOpts): Promise<CommandResult> {
  if (typeof opts.fqn !== "string" || opts.fqn.trim() === "") {
    return { exitCode: 2, stderr: "mcp fqn is required\n" };
  }
  const content = await readContentPayload(opts);
  if (typeof content !== "string") return { exitCode: 2, stderr: `${content.error}\n` };
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    await client.call("catalog.mcps.updateContent", {
      params: { id, name: opts.fqn },
      body: { content },
    });
    return { exitCode: 0, stdout: `mcp ${opts.fqn} updated\n` };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpRmOpts extends CommonFlags {
  readonly fqn: string;
}

export async function catalogMcpRm(opts: CatalogMcpRmOpts): Promise<CommandResult> {
  if (typeof opts.fqn !== "string" || opts.fqn.trim() === "") {
    return { exitCode: 2, stderr: "mcp fqn is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    await client.call("catalog.mcps.delete", {
      params: { id, name: opts.fqn },
    });
    return { exitCode: 0, stdout: `mcp ${opts.fqn} removed\n` };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpSyncResolveOpts extends CommonFlags {
  readonly fqn: string;
}

/** Mirror of {@link catalogSkillSyncResolve} for MCPs. */
export async function catalogMcpSyncResolve(
  opts: CatalogMcpSyncResolveOpts,
): Promise<CommandResult> {
  if (typeof opts.fqn !== "string" || opts.fqn.trim() === "") {
    return { exitCode: 2, stderr: "mcp fqn is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const plan = await client.call("catalog.mcps.syncResolve", {
      params: { id, name: opts.fqn },
    });
    return { exitCode: 0, stdout: formatJson(plan) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpSyncOpts extends CommonFlags {
  readonly fqn: string;
  readonly planToken: string;
}

/** Mirror of {@link catalogSkillSync} for MCPs. */
export async function catalogMcpSync(opts: CatalogMcpSyncOpts): Promise<CommandResult> {
  if (typeof opts.fqn !== "string" || opts.fqn.trim() === "") {
    return { exitCode: 2, stderr: "mcp fqn is required\n" };
  }
  if (typeof opts.planToken !== "string" || opts.planToken.trim() === "") {
    return { exitCode: 2, stderr: "--plan-token is required (mint with `mcp sync-resolve`)\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const result = await client.call("catalog.mcps.sync", {
      params: { id, name: opts.fqn },
      body: { planToken: opts.planToken },
    });
    return { exitCode: 0, stdout: formatJson(result) };
  } catch (err) {
    return formatError(err);
  }
}
