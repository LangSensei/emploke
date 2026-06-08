/**
 * `@emploke/cli` — top-level entry. Wires up `commander`, registers
 * every subcommand (lifecycle + workspace + ~40 API-mapping commands
 * via per-domain registrars), and dispatches.
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
 *
 * Layering: lifecycle commands (`serve` / `start` / `stop` / `restart`
 * / `status` / `logs`), the top-level `help` shortcut, and the small
 * `health` / `config` / `runtime` / `workspace` subtrees stay here.
 * The four repetitive-or-bulky subtrees — `catalog`, `schedule`,
 * `session`, `task` — live in `./registrars/*.ts`; the `catalog`
 * registrar is data-driven (skills/agents/MCPs differ only in a few
 * fields), the others are pure relocations to keep this file at a
 * scannable size.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { config } from "./commands/config.js";
import { health } from "./commands/health.js";
import { logs } from "./commands/logs.js";
import { type RestartOpts, restart } from "./commands/restart.js";
import { runtimeList } from "./commands/runtime.js";
import { type ServeOpts, serve } from "./commands/serve.js";
import { type StartOpts, start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
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
import {
  optionalString,
  parseConnectFlags,
  pickString,
  type Slot,
  withConnectFlags,
} from "./registrars/_shared.js";
import { registerCatalogCommands } from "./registrars/catalog.js";
import { registerScheduleCommands } from "./registrars/schedule.js";
import { registerSessionCommands } from "./registrars/session.js";
import { registerTaskCommands } from "./registrars/task.js";
import { registerWorkflowCommands } from "./registrars/workflow.js";

/** Exit code for usage / parse errors (POSIX EX_USAGE convention). */
const EX_USAGE = 2;

/**
 * `emploke` CLI entry point. Returns the intended exit code; the bin
 * layer is responsible for `process.exit`. This split lets tests
 * assert on exit codes without aborting the test runner.
 */
export async function run(argv: string[] = process.argv): Promise<number> {
  const slot: Slot = { result: null };
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
function buildProgram(slot: Slot, argv: string[]): Command {
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
      "--workspace-dir <path>",
      "Absolute filesystem path (default: <EMPLOKE_HOME>/workspaces/<uuid>)",
    )
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workspaceAdd({
        ...parseConnectFlags(opts),
        name: pickString(opts, "name") ?? "",
        ...optionalString(opts, "workspaceDir"),
      });
    });
  withConnectFlags(workspaceCmd.command("current"))
    .description("Print the current workspace id")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workspaceCurrent(parseConnectFlags(opts));
    });
  withConnectFlags(workspaceCmd.command("use"))
    // Argument is OPTIONAL `[id]` (not `<id>`) so the stub's
    // redirection message wins even when the user types
    // `emploke workspace use` with no id (muscle memory). Otherwise
    // commander would print its own "missing required argument" and
    // skip our message entirely. The stub handles a missing id by
    // substituting an `<id>` placeholder in the suggested commands.
    .argument("[id]", "Workspace id (kept for compatibility; this subcommand is removed)")
    .description("REMOVED: see `emploke workspace use --help` for migration")
    .action(async (id: string | undefined, opts: Record<string, unknown>) => {
      slot.result = await workspaceUse({ ...parseConnectFlags(opts), id: id ?? "" });
    });
  withConnectFlags(workspaceCmd.command("show"))
    .argument("<id>", "Workspace id")
    .description("Print one workspace's metadata")
    .action(async (id: string, opts: Record<string, unknown>) => {
      slot.result = await workspaceShow({ ...parseConnectFlags(opts), id });
    });
  withConnectFlags(workspaceCmd.command("update"))
    .argument("<id>", "Workspace id")
    .description("Update name")
    .option("--name <name>", "New display name")
    .action(async (id: string, opts: Record<string, unknown>) => {
      slot.result = await workspaceUpdate({
        ...parseConnectFlags(opts),
        id,
        ...optionalString(opts, "name"),
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

  // ─── API: bulk-registered subtrees (workspace-scoped) ──────────────
  registerSessionCommands(program, slot);
  registerScheduleCommands(program, slot);
  registerTaskCommands(program, slot);
  registerWorkflowCommands(program, slot);
  registerCatalogCommands(program, slot);

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
