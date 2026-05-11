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
  readonly apiKey?: string;
  readonly home?: string;
  readonly workspace?: string;
  readonly output?: string;
  readonly json?: boolean;
}

// ─── overview ──────────────────────────────────────────────────────────
export type CatalogOverviewOpts = CommonFlags;

export async function catalogOverview(opts: CatalogOverviewOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
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
    return { error: `--content-file read failed: ${(err as Error).message}` };
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
      return { error: `--metadata-file read failed: ${(err as Error).message}` };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `--metadata JSON parse error: ${(err as Error).message}` };
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
    const id = await resolveWorkspace(opts, client);
    const list = await client.call("catalog.skills.list", { params: { id } });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["name", "origin", "status"],
        list.map((s) => [
          (s as { name?: string }).name ?? "",
          (s as { origin?: string }).origin ?? "",
          (s as { status?: string }).status ?? "",
        ]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillResolveOpts extends CommonFlags {
  readonly origin: string;
}

export async function catalogSkillResolve(opts: CatalogSkillResolveOpts): Promise<CommandResult> {
  if (typeof opts.origin !== "string" || opts.origin.trim() === "") {
    return { exitCode: 2, stderr: "skill origin is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const plan = await client.call("catalog.skills.resolve", {
      params: { id },
      body: { origin: opts.origin },
    });
    return { exitCode: 0, stdout: formatJson(plan) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillShowOpts extends CommonFlags {
  readonly name: string;
}

export async function catalogSkillShow(opts: CatalogSkillShowOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "skill name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const skill = await client.call("catalog.skills.get", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(skill) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogSkillInstallOpts extends CommonFlags {
  readonly origin: string;
}

export async function catalogSkillInstall(opts: CatalogSkillInstallOpts): Promise<CommandResult> {
  if (typeof opts.origin !== "string" || opts.origin.trim() === "") {
    return { exitCode: 2, stderr: "skill origin is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const result = await client.call("catalog.skills.install", {
      params: { id },
      body: { origin: opts.origin },
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
    const id = await resolveWorkspace(opts, client);
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
    const id = await resolveWorkspace(opts, client);
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
    const id = await resolveWorkspace(opts, client);
    await client.call("catalog.skills.delete", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: `skill ${opts.name} removed\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── agents ────────────────────────────────────────────────────────────

export type CatalogAgentListOpts = CommonFlags;

export async function catalogAgentList(opts: CatalogAgentListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const list = await client.call("catalog.agents.list", { params: { id } });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["name", "origin", "status"],
        list.map((a) => [
          (a as { name?: string }).name ?? "",
          (a as { origin?: string }).origin ?? "",
          (a as { status?: string }).status ?? "",
        ]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentResolveOpts extends CommonFlags {
  readonly origin: string;
}

export async function catalogAgentResolve(opts: CatalogAgentResolveOpts): Promise<CommandResult> {
  if (typeof opts.origin !== "string" || opts.origin.trim() === "") {
    return { exitCode: 2, stderr: "agent origin is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const plan = await client.call("catalog.agents.resolve", {
      params: { id },
      body: { origin: opts.origin },
    });
    return { exitCode: 0, stdout: formatJson(plan) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentShowOpts extends CommonFlags {
  readonly name: string;
}

export async function catalogAgentShow(opts: CatalogAgentShowOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "agent name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const agent = await client.call("catalog.agents.get", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(agent) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogAgentInstallOpts extends CommonFlags {
  readonly origin: string;
}

export async function catalogAgentInstall(opts: CatalogAgentInstallOpts): Promise<CommandResult> {
  if (typeof opts.origin !== "string" || opts.origin.trim() === "") {
    return { exitCode: 2, stderr: "agent origin is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const result = await client.call("catalog.agents.install", {
      params: { id },
      body: { origin: opts.origin },
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
    const id = await resolveWorkspace(opts, client);
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
    const id = await resolveWorkspace(opts, client);
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
    const id = await resolveWorkspace(opts, client);
    await client.call("catalog.agents.delete", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: `agent ${opts.name} removed\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── mcps ──────────────────────────────────────────────────────────────

export type CatalogMcpListOpts = CommonFlags;

export async function catalogMcpList(opts: CatalogMcpListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const list = await client.call("catalog.mcps.list", { params: { id } });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["name", "origin", "mutable"],
        list.map((m) => [
          (m as { name?: string }).name ?? "",
          (m as { origin?: string }).origin ?? "",
          String((m as { mutable?: boolean }).mutable ?? ""),
        ]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpShowOpts extends CommonFlags {
  readonly name: string;
}

export async function catalogMcpShow(opts: CatalogMcpShowOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "mcp name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const mcp = await client.call("catalog.mcps.get", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(mcp) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpInstallOpts extends CommonFlags {
  readonly origin: string;
  readonly name: string;
}

export async function catalogMcpInstall(opts: CatalogMcpInstallOpts): Promise<CommandResult> {
  if (typeof opts.origin !== "string" || opts.origin.trim() === "") {
    return { exitCode: 2, stderr: "mcp origin is required\n" };
  }
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "mcp name (FQN <namespace>/<short>) is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const result = await client.call("catalog.mcps.install", {
      params: { id },
      body: { origin: opts.origin, name: opts.name },
    });
    return { exitCode: 0, stdout: formatJson(result) };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpUpdateOpts extends CommonFlags {
  readonly name: string;
  readonly content?: string;
  readonly contentFile?: string;
}

export async function catalogMcpUpdate(opts: CatalogMcpUpdateOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "mcp name is required\n" };
  }
  const content = await readContentPayload(opts);
  if (typeof content !== "string") return { exitCode: 2, stderr: `${content.error}\n` };
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    await client.call("catalog.mcps.updateContent", {
      params: { id, name: opts.name },
      body: { content },
    });
    return { exitCode: 0, stdout: `mcp ${opts.name} updated\n` };
  } catch (err) {
    return formatError(err);
  }
}

export interface CatalogMcpRmOpts extends CommonFlags {
  readonly name: string;
}

export async function catalogMcpRm(opts: CatalogMcpRmOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "mcp name is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    await client.call("catalog.mcps.delete", {
      params: { id, name: opts.name },
    });
    return { exitCode: 0, stdout: `mcp ${opts.name} removed\n` };
  } catch (err) {
    return formatError(err);
  }
}
