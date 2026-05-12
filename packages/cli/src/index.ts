/**
 * `@emploke/cli` — top-level entry. Wires up `commander`, registers
 * every subcommand (lifecycle + 41 API-mapping commands), and dispatches.
 *
 * Public surface:
 *  - `run(argv)` — invoke the CLI with a custom argv (handy for tests).
 *    Returns the exit code instead of touching `process.exit`, so tests
 *    can assert on it without aborting the runner.
 *
 * The bin (`./bin.ts`) calls `run(process.argv)` and exits with the
 * returned code.
 *
 * Why commander (not cac): nested subcommands. The CLI ships ~30
 * grouped commands (`workspace list`, `catalog skill install`, …) and
 * cac matches commands by single argv tokens — `cli.command("workspace
 * list", ...)` registers a literal "workspace list" name that nothing
 * can invoke. Commander handles nested `program.command("workspace")
 * .command("list")` natively.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import {
  catalogAgentInstall,
  catalogAgentList,
  catalogAgentPatch,
  catalogAgentResolve,
  catalogAgentRm,
  catalogAgentShow,
  catalogAgentUpdate,
  catalogMcpInstall,
  catalogMcpList,
  catalogMcpRm,
  catalogMcpShow,
  catalogMcpUpdate,
  catalogOverview,
  catalogSkillInstall,
  catalogSkillList,
  catalogSkillPatch,
  catalogSkillResolve,
  catalogSkillRm,
  catalogSkillShow,
  catalogSkillUpdate,
} from "./commands/catalog.js";
import { config } from "./commands/config.js";
import { health } from "./commands/health.js";
import { logs } from "./commands/logs.js";
import { type RestartOpts, restart } from "./commands/restart.js";
import { runtimeList } from "./commands/runtime.js";
import { type ServeOpts, serve } from "./commands/serve.js";
import {
  sessionList,
  sessionNew,
  sessionRm,
  sessionShow,
  sessionSpawn,
} from "./commands/session.js";
import { type StartOpts, start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import { taskActivity, taskDispatch, taskList, taskRm, taskShow } from "./commands/task.js";
import {
  workspaceAdd,
  workspaceCurrent,
  workspaceList,
  workspaceReload,
  workspaceRm,
  workspaceShow,
  workspaceUpdate,
  workspaceUse,
} from "./commands/workspace.js";
import type { CommandResult } from "./result.js";

/** Exit code for usage / parse errors (POSIX EX_USAGE convention). */
const EX_USAGE = 2;

/**
 * `emploke` CLI entry point. Returns the intended exit code; the bin
 * layer is responsible for `process.exit`. This split lets tests
 * assert on exit codes without aborting the test runner.
 */
export async function run(argv: string[] = process.argv): Promise<number> {
  const slot: { result: CommandResult | null } = { result: null };
  const program = buildProgram(slot, argv);

  // No-args: print top-level help.
  if (argv.length <= 2) {
    program.outputHelp();
    return 0;
  }

  // `emploke help` / `emploke help <subcommand...>` short-circuits so
  // the caller doesn't have to remember `--help` placement.
  if (argv[2] === "help") {
    if (argv.length === 3) {
      program.outputHelp();
      return 0;
    }
    return run([argv[0] ?? "node", argv[1] ?? "emploke", ...argv.slice(3), "--help"]);
  }

  try {
    await program.parseAsync(argv, { from: "node" });
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander throws for --help, --version, missing required args, etc.
      // help/version are exit 0; everything else collapses to a usage
      // error (commander's own exit codes are inconsistent — `1` for
      // unknown command, `1` for missing required option — so map
      // them all to EX_USAGE for predictable scripting).
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        return 0;
      }
      return EX_USAGE;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (slot.result) {
    if (slot.result.stdout) process.stdout.write(slot.result.stdout);
    if (slot.result.stderr) process.stderr.write(slot.result.stderr);
    return slot.result.exitCode;
  }
  return 0;
}

/**
 * Build the commander tree. The `slot` parameter is the cross-action
 * sink for {@link CommandResult} payloads — every action assigns to it;
 * the caller emits stdout / stderr / exit code from outside the action
 * so tests can swap the stdio destination.
 */
function buildProgram(slot: { result: CommandResult | null }, argv: string[]): Command {
  const program = new Command();
  program
    .name("emploke")
    .description("Orchestrate agentic systems built on the MetaAgents format spec")
    .version(readPackageVersion(), "-v, --version", "Print the CLI version")
    .helpOption("-h, --help", "Display this message")
    .showHelpAfterError("(run `emploke help` for usage)")
    .exitOverride();

  // ─── lifecycle ─────────────────────────────────────────────────────
  program
    .command("serve")
    .description("Run the emploke server in the foreground")
    .option("-p, --port <port>", "Listen port (env: PORT, default 8787)")
    .option("--host <host>", "Bind host (env: EMPLOKE_HOST, default 127.0.0.1)")
    .option("--api-key <key>", "Require this bearer token on /api/* (env: EMPLOKE_API_KEY)")
    .option("--no-serve-static", "Do not serve the dashboard SPA")
    .option("--static-dir <dir>", "Override the dashboard SPA directory")
    .option("--log-level <level>", "Log level (debug | info | warn | error)")
    .option("--log-format <fmt>", "Log format on stdout (pretty | json)")
    .action(async (opts: Record<string, unknown>) => {
      await serve(parseServeFlags(opts));
    });

  program
    .command("start")
    .description("Start the emploke server as a detached background process")
    .option("-p, --port <port>", "Listen port (env: PORT, default 8787)")
    .option("--host <host>", "Bind host (env: EMPLOKE_HOST, default 127.0.0.1)")
    .option("--api-key <key>", "Require this bearer token on /api/* (env: EMPLOKE_API_KEY)")
    .option("--no-serve-static", "Do not serve the dashboard SPA")
    .option("--static-dir <dir>", "Override the dashboard SPA directory")
    .option("--log-level <level>", "Log level (debug | info | warn | error)")
    .option("--log-format <fmt>", "Log format on stdout (pretty | json)")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await start(parseServeFlags(opts) as StartOpts);
    });

  program
    .command("stop")
    .description("Stop a running emploke server")
    .action(async () => {
      slot.result = await stop();
    });

  program
    .command("restart")
    .description("Stop and start the emploke server")
    .option("-p, --port <port>", "Listen port (env: PORT, default 8787)")
    .option("--host <host>", "Bind host (env: EMPLOKE_HOST, default 127.0.0.1)")
    .option("--api-key <key>", "Require this bearer token on /api/* (env: EMPLOKE_API_KEY)")
    .option("--no-serve-static", "Do not serve the dashboard SPA")
    .option("--static-dir <dir>", "Override the dashboard SPA directory")
    .option("--log-level <level>", "Log level (debug | info | warn | error)")
    .option("--log-format <fmt>", "Log format on stdout (pretty | json)")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await restart(parseServeFlags(opts) as RestartOpts);
    });

  program
    .command("status")
    .description("Print whether the emploke server is running")
    .option("--json", "Emit a JSON payload instead of a one-line summary")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await status({ json: opts.json === true });
    });

  program
    .command("logs")
    .description("Print the server log file")
    .option("-f, --follow", "Follow the log as it grows (Ctrl-C to stop)")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await logs({ follow: opts.follow === true });
    });

  program
    .command("help [subcommand...]")
    .description("Show help for emploke or a subcommand")
    .action(async (subcommand: string[] | undefined) => {
      if (!subcommand || subcommand.length === 0) {
        program.outputHelp();
        return;
      }
      await run([argv[0] ?? "node", argv[1] ?? "emploke", ...subcommand, "--help"]);
    });

  // ─── API: top-level singletons ─────────────────────────────────────
  withConnectFlags(program.command("health"))
    .description("Probe the server's /api/health endpoint")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await health(parseConnectFlags(opts));
    });

  withConnectFlags(program.command("config"))
    .description("Print the server's resolved configuration")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await config(parseConnectFlags(opts));
    });

  // ─── API: runtime ──────────────────────────────────────────────────
  const runtimeCmd = program.command("runtime").description("Runtime registry operations");
  withConnectFlags(runtimeCmd.command("list"))
    .description("List the registered runtimes")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await runtimeList(parseConnectFlags(opts));
    });

  // ─── API: workspace ────────────────────────────────────────────────
  const workspaceCmd = program.command("workspace").description("Workspace operations");

  withConnectFlags(workspaceCmd.command("list"))
    .description("List all workspaces")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workspaceList(parseConnectFlags(opts));
    });
  withConnectFlags(workspaceCmd.command("add"))
    .description("Create a new workspace")
    .requiredOption("--name <name>", "Display name")
    .option(
      "--workdir <path>",
      "Absolute filesystem path (default: <EMPLOKE_HOME>/workspaces/<uuid>)",
    )
    .option("--defaults <json>", "Inline JSON object for the defaults bag")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workspaceAdd({
        ...parseConnectFlags(opts),
        name: pickString(opts, "name") ?? "",
        ...optionalString(opts, "workdir"),
        ...optionalString(opts, "defaults"),
      });
    });
  withConnectFlags(workspaceCmd.command("current"))
    .description("Print the current workspace id")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workspaceCurrent(parseConnectFlags(opts));
    });
  withConnectFlags(workspaceCmd.command("use"))
    .argument("<id>", "Workspace id to mark current")
    .description("Set the current workspace by id")
    .action(async (id: string, opts: Record<string, unknown>) => {
      slot.result = await workspaceUse({ ...parseConnectFlags(opts), id });
    });
  withConnectFlags(workspaceCmd.command("show"))
    .argument("<id>", "Workspace id")
    .description("Print one workspace's metadata")
    .action(async (id: string, opts: Record<string, unknown>) => {
      slot.result = await workspaceShow({ ...parseConnectFlags(opts), id });
    });
  withConnectFlags(workspaceCmd.command("update"))
    .argument("<id>", "Workspace id")
    .description("Update name / defaults")
    .option("--name <name>", "New display name")
    .option("--defaults <json>", "Inline JSON object (or 'null' to clear)")
    .action(async (id: string, opts: Record<string, unknown>) => {
      slot.result = await workspaceUpdate({
        ...parseConnectFlags(opts),
        id,
        ...optionalString(opts, "name"),
        ...optionalString(opts, "defaults"),
      });
    });
  withConnectFlags(workspaceCmd.command("rm"))
    .argument("<id>", "Workspace id")
    .description("Remove a workspace")
    .option("--purge", "Also remove the workspace's emploke-managed subdirs")
    .action(async (id: string, opts: Record<string, unknown>) => {
      slot.result = await workspaceRm({
        ...parseConnectFlags(opts),
        id,
        purge: opts.purge === true,
      });
    });
  withConnectFlags(workspaceCmd.command("reload"))
    .argument("<id>", "Workspace id")
    .description("Force the server to rebuild the workspace context")
    .action(async (id: string, opts: Record<string, unknown>) => {
      slot.result = await workspaceReload({ ...parseConnectFlags(opts), id });
    });

  // ─── API: session (workspace-scoped) ───────────────────────────────
  const sessionCmd = program
    .command("session")
    .description("Session operations (workspace-scoped)");

  withWorkspaceFlags(sessionCmd.command("list"))
    .description("List sessions in the current workspace")
    .option("--agent <name>", "Filter by agent name")
    .option("--created-since <iso>", "Drop sessions created before this ISO 8601 timestamp")
    .option("--active-since <iso>", "Drop sessions inactive before this ISO 8601 timestamp")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await sessionList({
        ...parseWorkspaceFlags(opts),
        ...optionalString(opts, "agent"),
        ...optionalString(opts, "createdSince"),
        ...optionalString(opts, "activeSince"),
      });
    });
  withWorkspaceFlags(sessionCmd.command("new"))
    .description("Create a new session")
    .requiredOption("--agent <name>", "Agent to bake into the session")
    .option("--runtime <kind>", "Runtime override (default: workspace default)")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await sessionNew({
        ...parseWorkspaceFlags(opts),
        agent: pickString(opts, "agent") ?? "",
        ...optionalString(opts, "runtime"),
      });
    });
  withWorkspaceFlags(sessionCmd.command("show"))
    .argument("<sid>", "Session id")
    .description("Print one session's metadata")
    .action(async (sid: string, opts: Record<string, unknown>) => {
      slot.result = await sessionShow({ ...parseWorkspaceFlags(opts), sid });
    });
  withWorkspaceFlags(sessionCmd.command("rm"))
    .argument("<sid>", "Session id")
    .description("Remove a session")
    .option(
      "--purge",
      "Hard delete: also remove the session workdir and the runtime's per-session state (default is archive — row only)",
    )
    .action(async (sid: string, opts: Record<string, unknown>) => {
      slot.result = await sessionRm({
        ...parseWorkspaceFlags(opts),
        sid,
        purge: opts.purge === true,
      });
    });
  withWorkspaceFlags(sessionCmd.command("spawn"))
    .argument("<sid>", "Session id")
    .description("Spawn a terminal for the session")
    .option("--remote", "Build a remote-launch command instead of local")
    .action(async (sid: string, opts: Record<string, unknown>) => {
      slot.result = await sessionSpawn({
        ...parseWorkspaceFlags(opts),
        sid,
        remote: opts.remote === true,
      });
    });

  // ─── API: task (workspace-scoped) ──────────────────────────────────
  const taskCmd = program.command("task").description("Task operations (workspace-scoped)");

  withWorkspaceFlags(taskCmd.command("list"))
    .description("List tasks in the current workspace")
    .option("--agent <name>", "Filter by agent name")
    .option("--runtime <kind>", "Filter by runtime kind")
    .option("--created-since <iso>", "Drop tasks created before this ISO 8601 timestamp")
    .option(
      "--status <csv>",
      "Comma-separated list (not_started, running, success, failure, cancelled)",
    )
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await taskList({
        ...parseWorkspaceFlags(opts),
        ...optionalString(opts, "agent"),
        ...optionalString(opts, "runtime"),
        ...optionalString(opts, "createdSince"),
        ...optionalString(opts, "status"),
      });
    });
  withWorkspaceFlags(taskCmd.command("dispatch"))
    .description("Dispatch a new task")
    .requiredOption("--agent <name>", "Agent to run")
    .requiredOption("--instructions <text>", "Instructions to give the agent")
    .option("--runtime <kind>", "Runtime override (default: workspace default)")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await taskDispatch({
        ...parseWorkspaceFlags(opts),
        agent: pickString(opts, "agent") ?? "",
        instructions: pickString(opts, "instructions") ?? "",
        ...optionalString(opts, "runtime"),
      });
    });
  withWorkspaceFlags(taskCmd.command("show"))
    .argument("<tid>", "Task id")
    .description("Print one task's metadata")
    .action(async (tid: string, opts: Record<string, unknown>) => {
      slot.result = await taskShow({ ...parseWorkspaceFlags(opts), tid });
    });
  withWorkspaceFlags(taskCmd.command("rm"))
    .argument("<tid>", "Task id")
    .description("Remove a task")
    .option(
      "--purge",
      "Hard delete: also remove the task workdir and the runtime's per-task state (default is archive — row only)",
    )
    .action(async (tid: string, opts: Record<string, unknown>) => {
      slot.result = await taskRm({
        ...parseWorkspaceFlags(opts),
        tid,
        purge: opts.purge === true,
      });
    });
  withWorkspaceFlags(taskCmd.command("activity"))
    .argument("<tid>", "Task id")
    .description("Print the runtime-parsed activity timeline (JSON)")
    .option("-f, --follow", "Tail live activity over SSE; exits when task terminates")
    .option("--cursor <seq>", "Only return items with seq > cursor (for pagination)")
    .option("--limit <n>", "Maximum items per page (default 50, max 500)", (v) =>
      Number.parseInt(v, 10),
    )
    .action(async (tid: string, opts: Record<string, unknown>) => {
      const cursor =
        typeof opts.cursor === "string"
          ? Number.parseInt(opts.cursor, 10)
          : typeof opts.cursor === "number"
            ? opts.cursor
            : undefined;
      const limit = typeof opts.limit === "number" ? opts.limit : undefined;
      slot.result = await taskActivity({
        ...parseWorkspaceFlags(opts),
        tid,
        follow: opts.follow === true,
        ...(cursor !== undefined && Number.isFinite(cursor) ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    });

  // ─── API: catalog (workspace-scoped) ───────────────────────────────
  const catalogCmd = program
    .command("catalog")
    .description("Catalog operations (workspace-scoped)");

  withWorkspaceFlags(catalogCmd.command("overview"))
    .description("Per-workspace catalog counts")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await catalogOverview(parseWorkspaceFlags(opts));
    });

  // skills
  const catalogSkill = catalogCmd.command("skill").description("Skill operations");
  withWorkspaceFlags(catalogSkill.command("list"))
    .description("List installed skills")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await catalogSkillList(parseWorkspaceFlags(opts));
    });
  withWorkspaceFlags(catalogSkill.command("resolve"))
    .argument("<origin>", "Skill origin (path / git / npm)")
    .description("Preview an install plan")
    .action(async (origin: string, opts: Record<string, unknown>) => {
      slot.result = await catalogSkillResolve({ ...parseWorkspaceFlags(opts), origin });
    });
  withWorkspaceFlags(catalogSkill.command("show"))
    .argument("<name>", "Skill name (FQN)")
    .description("Show one skill's content")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogSkillShow({ ...parseWorkspaceFlags(opts), name });
    });
  withWorkspaceFlags(catalogSkill.command("install"))
    .argument("<origin>", "Skill origin")
    .description("Install a skill")
    .action(async (origin: string, opts: Record<string, unknown>) => {
      slot.result = await catalogSkillInstall({ ...parseWorkspaceFlags(opts), origin });
    });
  withWorkspaceFlags(catalogSkill.command("update"))
    .argument("<name>", "Skill name (FQN)")
    .description("Replace skill content")
    .option("--content <text>", "Inline content")
    .option("--content-file <path>", "Read content from file")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogSkillUpdate({
        ...parseWorkspaceFlags(opts),
        name,
        ...optionalString(opts, "content"),
        ...optionalString(opts, "contentFile"),
      });
    });
  withWorkspaceFlags(catalogSkill.command("patch"))
    .argument("<name>", "Skill name (FQN)")
    .description("Patch skill metadata")
    .option("--metadata <json>", "Inline JSON object")
    .option("--metadata-file <path>", "Read JSON object from file")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogSkillPatch({
        ...parseWorkspaceFlags(opts),
        name,
        ...optionalString(opts, "metadata"),
        ...optionalString(opts, "metadataFile"),
      });
    });
  withWorkspaceFlags(catalogSkill.command("rm"))
    .argument("<name>", "Skill name (FQN)")
    .description("Remove a skill")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogSkillRm({ ...parseWorkspaceFlags(opts), name });
    });

  // agents
  const catalogAgent = catalogCmd.command("agent").description("Agent operations");
  withWorkspaceFlags(catalogAgent.command("list"))
    .description("List installed agents")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await catalogAgentList(parseWorkspaceFlags(opts));
    });
  withWorkspaceFlags(catalogAgent.command("resolve"))
    .argument("<origin>", "Agent origin")
    .description("Preview an install plan")
    .action(async (origin: string, opts: Record<string, unknown>) => {
      slot.result = await catalogAgentResolve({ ...parseWorkspaceFlags(opts), origin });
    });
  withWorkspaceFlags(catalogAgent.command("show"))
    .argument("<name>", "Agent name (FQN)")
    .description("Show one agent's content")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogAgentShow({ ...parseWorkspaceFlags(opts), name });
    });
  withWorkspaceFlags(catalogAgent.command("install"))
    .argument("<origin>", "Agent origin")
    .description("Install an agent")
    .action(async (origin: string, opts: Record<string, unknown>) => {
      slot.result = await catalogAgentInstall({ ...parseWorkspaceFlags(opts), origin });
    });
  withWorkspaceFlags(catalogAgent.command("update"))
    .argument("<name>", "Agent name (FQN)")
    .description("Replace agent content")
    .option("--content <text>", "Inline content")
    .option("--content-file <path>", "Read content from file")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogAgentUpdate({
        ...parseWorkspaceFlags(opts),
        name,
        ...optionalString(opts, "content"),
        ...optionalString(opts, "contentFile"),
      });
    });
  withWorkspaceFlags(catalogAgent.command("patch"))
    .argument("<name>", "Agent name (FQN)")
    .description("Patch agent metadata")
    .option("--metadata <json>", "Inline JSON object")
    .option("--metadata-file <path>", "Read JSON object from file")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogAgentPatch({
        ...parseWorkspaceFlags(opts),
        name,
        ...optionalString(opts, "metadata"),
        ...optionalString(opts, "metadataFile"),
      });
    });
  withWorkspaceFlags(catalogAgent.command("rm"))
    .argument("<name>", "Agent name (FQN)")
    .description("Remove an agent")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogAgentRm({ ...parseWorkspaceFlags(opts), name });
    });

  // mcps
  const catalogMcp = catalogCmd.command("mcp").description("MCP operations");
  withWorkspaceFlags(catalogMcp.command("list"))
    .description("List installed MCPs")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await catalogMcpList(parseWorkspaceFlags(opts));
    });
  withWorkspaceFlags(catalogMcp.command("show"))
    .argument("<name>", "MCP name (<namespace>/<short>)")
    .description("Show one MCP's content")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogMcpShow({ ...parseWorkspaceFlags(opts), name });
    });
  withWorkspaceFlags(catalogMcp.command("install"))
    .argument("<origin>", "MCP origin")
    .requiredOption("--name <fqn>", "MCP FQN (<namespace>/<short>)")
    .description("Install an MCP")
    .action(async (origin: string, opts: Record<string, unknown>) => {
      slot.result = await catalogMcpInstall({
        ...parseWorkspaceFlags(opts),
        origin,
        name: pickString(opts, "name") ?? "",
      });
    });
  withWorkspaceFlags(catalogMcp.command("update"))
    .argument("<name>", "MCP name (<namespace>/<short>)")
    .description("Replace MCP JSON content")
    .option("--content <text>", "Inline content")
    .option("--content-file <path>", "Read content from file")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogMcpUpdate({
        ...parseWorkspaceFlags(opts),
        name,
        ...optionalString(opts, "content"),
        ...optionalString(opts, "contentFile"),
      });
    });
  withWorkspaceFlags(catalogMcp.command("rm"))
    .argument("<name>", "MCP name (<namespace>/<short>)")
    .description("Remove an MCP")
    .action(async (name: string, opts: Record<string, unknown>) => {
      slot.result = await catalogMcpRm({ ...parseWorkspaceFlags(opts), name });
    });

  return program;
}

// ─── Flag-parsing helpers ─────────────────────────────────────────────

function parseServeFlags(opts: Record<string, unknown>): ServeOpts {
  type Mutable = { -readonly [K in keyof ServeOpts]: ServeOpts[K] };
  const out: Mutable = {};
  const port = opts.port;
  if (typeof port === "number") out.port = port;
  else if (typeof port === "string" && port !== "") out.port = Number(port);
  if (typeof opts.host === "string") out.host = opts.host;
  if (typeof opts.apiKey === "string") out.apiKey = opts.apiKey;
  if (opts.serveStatic === false) out.serveStatic = false;
  if (typeof opts.staticDir === "string") out.staticDir = opts.staticDir;
  const level = opts.logLevel;
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    out.logLevel = level;
  }
  const fmt = opts.logFormat;
  if (fmt === "pretty" || fmt === "json") out.logFormat = fmt;
  return out;
}

interface ConnectFlagOpts {
  server?: string;
  apiKey?: string;
  output?: string;
  json?: boolean;
}

interface WorkspaceFlagOpts extends ConnectFlagOpts {
  workspace?: string;
}

function parseConnectFlags(opts: Record<string, unknown>): ConnectFlagOpts {
  const out: ConnectFlagOpts = {};
  const server = pickString(opts, "server");
  if (server !== undefined) out.server = server;
  const apiKey = pickString(opts, "apiKey");
  if (apiKey !== undefined) out.apiKey = apiKey;
  const output = pickString(opts, "output");
  if (output !== undefined) out.output = output;
  if (opts.json === true) out.json = true;
  return out;
}

function parseWorkspaceFlags(opts: Record<string, unknown>): WorkspaceFlagOpts {
  const out: WorkspaceFlagOpts = parseConnectFlags(opts);
  const workspace = pickString(opts, "workspace");
  if (workspace !== undefined) out.workspace = workspace;
  return out;
}

/** Extract a string flag from commander's already-camelCased options object. */
function pickString(opts: Record<string, unknown>, key: string): string | undefined {
  const v = opts[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Conditional spread builder. Returns either `{}` or `{ <key>: value }`
 * so the caller can spread into an opts object without including
 * `undefined` properties (which would violate `exactOptionalPropertyTypes`).
 */
function optionalString<K extends string>(
  opts: Record<string, unknown>,
  key: K,
): { [P in K]?: string } {
  const v = pickString(opts, key);
  return v === undefined ? ({} as { [P in K]?: string }) : ({ [key]: v } as { [P in K]: string });
}

/**
 * Apply the common API-call flags (`--server`, `--api-key`, `--output`,
 * `--json`) to a command. Pulled into a helper so each registration
 * stays one `.option(...)` chain shorter.
 */
function withConnectFlags(c: Command): Command {
  return c
    .option("--server <url>", "Server URL (env: EMPLOKE_SERVER, runtime.json)")
    .option("--api-key <key>", "Bearer token for /api/* (env: EMPLOKE_API_KEY, runtime.json)")
    .option("--output <fmt>", "Output format: table | json")
    .option("--json", "Shorthand for --output json");
}

/** Workspace-scoped commands additionally take `--workspace`. */
function withWorkspaceFlags(c: Command): Command {
  return withConnectFlags(c).option(
    "-w, --workspace <id>",
    "Workspace id (env: EMPLOKE_WORKSPACE, server-side current)",
  );
}

/**
 * Best-effort version lookup. Tries:
 *   1. `<this-dir>/../package.json` — bundle layout (`bundle/emploke.js`
 *      → root `package.json` of the published `@langsensei/emploke`).
 *   2. `<this-dir>/../../package.json` — source layout
 *      (`packages/cli/dist/index.js` → `packages/cli/package.json`).
 *
 * Falls back to a placeholder so `emploke --version` never throws.
 */
function readPackageVersion(): string {
  let here: string;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return "0.0.0-unknown";
  }
  for (const candidate of [
    path.join(here, "..", "package.json"),
    path.join(here, "..", "..", "package.json"),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {}
  }
  return "0.0.0-unknown";
}
