import { open, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import {
  RuntimeDoesNotSupportRemoteError,
  RuntimeProvisionFailed,
  RuntimeReadActivityInvalidArgs,
  RuntimeRefreshFailed,
  RuntimeStateDeletionFailed,
} from "../errors.js";
import type { PlaceholderContext } from "../placeholders.js";
import type {
  ActivityItem,
  ActivityResult,
  BuildInteractiveLaunchOpts,
  LaunchCommand,
  LaunchHeadlessOpts,
  ProvisionContext,
  ReadActivityOpts,
  Runtime,
  RuntimeCapabilities,
  RuntimeHandle,
  RuntimeSessionMetadata,
  StreamActivityOpts,
  TruncationInfo,
} from "../types.js";
import {
  CopilotActivityStreamParser,
  deriveCopilotResult,
  parseCopilotActivity,
} from "./activity.js";
import { generateCopilotSessionId, isCopilotSessionId } from "./ids.js";
import { buildCopilotLaunchCommand } from "./launch.js";
import {
  type LaunchCopilotHeadlessDeps,
  type LaunchCopilotHeadlessOpts,
  launchCopilotHeadless,
} from "./launch-headless.js";
import { provisionCopilotWorkdir } from "./provision.js";
import { readCopilotSessionState, readCopilotWorkspaceYaml } from "./state.js";
import { ensureDirTrusted } from "./trust.js";

const DEFAULT_COPILOT_STATE_DIR = path.join(homedir(), ".copilot", "session-state");
const DEFAULT_COPILOT_CONFIG_PATH = path.join(homedir(), ".copilot", "config.json");
const DEFAULT_SHARED_DIR = path.join(homedir(), ".emploke", "shared");

export interface CopilotRuntimeConfig {
  /**
   * Override the directory where copilot stores per-session state. Defaults
   * to `~/.copilot/session-state`. Tests pass a tmp dir; production callers
   * normally leave this unset.
   */
  readonly copilotStateDir?: string;
  /**
   * Override the Copilot CLI config file we maintain `trustedFolders` in.
   * Defaults to `~/.copilot/config.json` — NOT `settings.json`. The Copilot
   * CLI (verified against 1.0.44) only reads trust state from
   * `config.json`; entries written to `settings.json.trustedFolders` are
   * silently ignored, even though the leading comment in `config.json`
   * misleadingly says "User settings belong in settings.json".
   *
   * Tests pass a tmp path so the real user config file is never mutated.
   *
   * Used exclusively by `buildInteractiveLaunch` (interactive mode preflight); per-
   * session `provision` and per-task `launchHeadless` do NOT touch this
   * file (see class jsdoc for the per-mode trust matrix).
   */
  readonly copilotConfigPath?: string;
  /**
   * Override the directory exposed to spec authors as `${sharedDir}` in
   * placeholder substitution. Defaults to `~/.emploke/shared`. Server
   * bootstrap normally derives this from `EMPLOKE_HOME` and passes it
   * explicitly so the value tracks any `EMPLOKE_HOME` override.
   *
   * Per-workspace state should NOT live here — spec authors use
   * `${workspaceDir}` for that. This dir is for state that is shared
   * across every workspace + session + task on the machine
   * (e.g. one playwright login the user wants every project to reuse).
   */
  readonly sharedDir?: string;
  /**
   * Test seam for id generation. Defaults to `crypto.randomUUID`.
   */
  readonly randomUUID?: () => string;
  /**
   * Optional injection of the headless-launch dependencies. Production callers
   * leave this unset; tests pass a stub spawn / mkdir to avoid actually
   * launching the CLI. `copilotStateDir` and `randomUUID` here, if
   * provided, override the top-level options for headless launch only.
   */
  readonly headlessDeps?: Partial<LaunchCopilotHeadlessDeps>;
}

/**
 * The Copilot adapter. Pre-allocates a UUID at provision time and threads it
 * through `--resume=<id>` on every launch, so first launch creates the session
 * and subsequent launches resume it. This eliminates the cwd-join logic the
 * old implementation needed (where copilot minted ids and we had to scan all
 * sessions and match by cwd).
 *
 * # Trust handling — per-mode (Copilot-specific, intentionally NOT abstracted)
 *
 * Trust resolution differs between Copilot's two execution modes; this is
 * a property of the Copilot CLI itself and is intentionally NOT lifted
 * into the cross-runtime `Runtime` interface. Each runtime adapter owns
 * its own preconditions and decides where in its lifecycle to enforce
 * them. There is no `registerWorkspace`-style hook on `Runtime`.
 *
 * Empirically verified against Copilot CLI 1.0.44:
 *
 *   | mode                | folder-trust gate?           | how to satisfy                |
 *   |---------------------|------------------------------|-------------------------------|
 *   | `-i` (interactive)  | yes — `cwd` (or an ancestor) | write `cwd` (or an ancestor)  |
 *   |  i.e. `buildInteractiveLaunch` |   must be in            |   to `~/.copilot/config.json` |
 *   |                     |   `config.json.trustedFolders` |  `trustedFolders`           |
 *   |                     |   else CLI shows blocking    |                               |
 *   |                     |   "Confirm folder trust"     |                               |
 *   |                     |   prompt                     |                               |
 *   |---------------------|------------------------------|-------------------------------|
 *   | `-p --yolo`         | none                         | nothing — `--yolo` (which     |
 *   |  i.e. `launchHeadless`|   (verified: even cross-   |   includes `--allow-all-paths`)|
 *   |                     |    drive absolute paths      |   bypasses the gate entirely  |
 *   |                     |    work with empty           |                               |
 *   |                     |    `trustedFolders`)         |                               |
 *
 * Two notes on the table:
 *
 * - The trust file is `config.json`, NOT `settings.json`. The leading
 *   comment in `config.json` says "User settings belong in settings.json.
 *   This file is managed automatically." — that comment is misleading for
 *   `trustedFolders` specifically: the CLI only reads trust from
 *   `config.json`, regardless of where the user writes it. Verified by
 *   placing identical entries in both files and observing that only the
 *   `config.json` entry suppresses the prompt.
 *
 * - `--add-dir` is NOT an alternative for `-i` mode (it's a file-access
 *   allowlist for `--allow-all-paths`-style flows; it does not pre-trust
 *   the folder for the interactive trust gate). So per-session
 *   `--add-dir` shims do not work as a transient. The only working knob
 *   for `-i` is the persistent `config.json` entry.
 *
 * Concretely, `buildInteractiveLaunch(session, workspaceDir)` ensures `workspaceDir`
 * is covered by `config.json.trustedFolders` immediately before returning
 * the launch spec — so trust I/O happens at the moment the user actually
 * launches an interactive session, not eagerly when the workspace is
 * registered. The write is idempotent and ancestor-aware: the first
 * launch in a workspace pays one read+write; every subsequent launch
 * passes `isPathCovered` and short-circuits without writing. `launchHeadless`
 * never touches the file because `-p --yolo` does not need trust.
 *
 * SECURITY: every method that would compose `runtimeSessionId` into a
 * filesystem path or a `--resume=<id>` argument runs it through
 * `isCopilotSessionId` first. A tampered `session.json` with a malicious id
 * (e.g. `"../../etc"` for path-traversal, or one with shell metacharacters
 * for the display string) is treated as if the id were null — refresh
 * returns "no activity", deleteState is a no-op, and buildInteractiveLaunch produces a
 * fresh launch (no --resume). That degrades gracefully for the user and
 * keeps the surface immune to malformed persisted state.
 */
export class CopilotRuntime implements Runtime {
  readonly kind = "copilot";

  /**
   * Capabilities Copilot's CLI implements that other runtimes might
   * not. Read by the server's `/api/runtimes` route → surfaced in the
   * dashboard so the "Spawn remote" button only renders enabled when
   * the active runtime supports it.
   *
   * - `remoteSession`: Copilot CLI 1.0.44+ accepts `--remote` to bridge
   *   the interactive session to a browser / mobile app via GitHub. See
   *   {@link buildInteractiveLaunch} for the per-launch wiring.
   */
  readonly capabilities: RuntimeCapabilities = {
    remoteSession: true,
  };

  private readonly copilotStateDir: string;
  private readonly copilotConfigPath: string;
  private readonly sharedDir: string;
  private readonly randomUUID: () => string;
  private readonly headlessDeps: Partial<LaunchCopilotHeadlessDeps>;

  constructor(config: CopilotRuntimeConfig = {}) {
    this.copilotStateDir = config.copilotStateDir ?? DEFAULT_COPILOT_STATE_DIR;
    this.copilotConfigPath = config.copilotConfigPath ?? DEFAULT_COPILOT_CONFIG_PATH;
    this.sharedDir = config.sharedDir ?? DEFAULT_SHARED_DIR;
    this.randomUUID = config.randomUUID ?? (() => generateCopilotSessionId());
    this.headlessDeps = config.headlessDeps ?? {};
  }

  async provision(
    workdir: string,
    agent: AgentResolveResult,
    catalog: CatalogManager,
    ctx: ProvisionContext,
  ): Promise<{ runtimeSessionId: string }> {
    const placeholders: PlaceholderContext = {
      workspaceDir: ctx.workspaceDir,
      sharedDir: this.sharedDir,
    };
    try {
      await provisionCopilotWorkdir(workdir, agent, catalog, placeholders);
    } catch (err) {
      throw new RuntimeProvisionFailed(this.kind, workdir, err as Error);
    }
    const runtimeSessionId = generateCopilotSessionId(this.randomUUID);
    return { runtimeSessionId };
  }

  /**
   * Build the launch incantation for an interactive Copilot session.
   *
   * Preflight side-effect: writes `workspaceDir` (idempotently, with
   * ancestor coverage) into `~/.copilot/config.json` `trustedFolders`
   * via `ensureDirTrusted`. This is the per-mode trust handling the
   * class jsdoc describes — it is intentionally NOT exposed as a
   * cross-runtime `Runtime` method, because trust shape varies across
   * CLIs. The first launch in a workspace pays one read+write; every
   * subsequent launch hits the "already covered" early return and
   * performs only a cheap read.
   *
   * If the trust write fails, the launch fails (`TrustRegistrationFailed`
   * propagates). That is the right behaviour: spawning Copilot anyway
   * would just stall on the blocking "Confirm folder trust" prompt
   * inside the freshly-spawned terminal, which is much worse UX than a
   * surfaced error in the dashboard.
   *
   * Pure (no I/O) on the runtimeSessionId branch: a tampered or absent
   * id falls through to `buildCopilotLaunchCommand` with a `null` id,
   * producing a fresh-launch form (no `--resume`). The trust write
   * still runs; that is not a security concern because workspaceDir is
   * controlled by the caller (server, not user input).
   */
  async buildInteractiveLaunch(
    runtimeSessionId: string | null,
    workdir: string,
    workspaceDir: string,
    opts: BuildInteractiveLaunchOpts = {},
  ): Promise<LaunchCommand> {
    if (opts.remote === true && this.capabilities.remoteSession !== true) {
      // Defensive: shouldn't fire because we set the capability above,
      // but the cross-runtime contract requires runtimes to refuse
      // unsupported flags rather than silently dropping them.
      throw new RuntimeDoesNotSupportRemoteError(this.kind);
    }
    await ensureDirTrusted(workspaceDir, this.copilotConfigPath);
    // Pass the id through the validator so a tampered persisted record
    // can't smuggle shell metacharacters into the displayed
    // `--resume=<id>` string.
    const id = safeCopilotId(runtimeSessionId);
    return buildCopilotLaunchCommand(workdir, id, opts);
  }

  async readMetadata(runtimeSessionId: string): Promise<RuntimeSessionMetadata | null> {
    const id = safeCopilotId(runtimeSessionId);
    if (id === null) {
      // Malformed id: no copilot state to read. Defensive — defends
      // against tampered persisted state the same way the other
      // observability methods do.
      return null;
    }
    try {
      const meta = await readCopilotWorkspaceYaml(this.copilotStateDir, id);
      if (meta === null) return null;
      return {
        title: meta.title,
        userTitled: meta.userTitled,
        lastActiveAt: meta.lastActiveAt,
      };
    } catch (err) {
      throw new RuntimeRefreshFailed(this.kind, id, err as Error);
    }
  }

  async deleteState(runtimeSessionId: string): Promise<void> {
    const id = safeCopilotId(runtimeSessionId);
    if (id === null) return;
    const dir = path.join(this.copilotStateDir, id);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      throw new RuntimeStateDeletionFailed(this.kind, id, err as Error);
    }
  }

  /**
   * Spawn copilot non-interactively against `opts.workdir` to consume
   * `opts.prompt` unattended. Delegates to `launchCopilotHeadless` so the
   * spawn machinery stays isolated and unit-testable. The returned
   * {@link RuntimeHandle} carries the runtime session id (so callers
   * can persist it for later inspection) and a pre-resolved
   * `sessionDir` Promise pointing at the just-created
   * `<copilotStateDir>/<id>/`.
   */
  async launchHeadless(opts: LaunchHeadlessOpts): Promise<RuntimeHandle> {
    return launchCopilotHeadless(
      {
        // launchCopilotHeadless still uses the legacy `taskDir` field
        // name internally (Copilot-specific impl detail). Map it.
        taskDir: opts.workdir,
        agent: opts.agent,
        catalog: opts.catalog,
        prompt: opts.prompt,
        workspaceDir: opts.workspaceDir,
        // Conditional spread so callers without an env override don't
        // poke an `undefined` into the field (forbidden under
        // tsconfig's `exactOptionalPropertyTypes`).
        ...(opts.subprocessEnv ? { subprocessEnv: opts.subprocessEnv } : {}),
      },
      {
        copilotStateDir: this.copilotStateDir,
        sharedDir: this.sharedDir,
        randomUUID: this.randomUUID,
        ...this.headlessDeps,
      },
    );
  }

  /**
   * Read + parse + derive — end-to-end. Reads `events.jsonl` from
   * `<copilotStateDir>/<runtimeSessionId>/`, lifts to ActivityItem[],
   * picks the headline result. Returns `null` if the file isn't on
   * disk yet (the conversation hasn't emitted its first event).
   *
   * The runtime owns the path discovery so consumers (server route,
   * dashboard) never see Copilot's internal `events.jsonl` shape or
   * its `~/.copilot/session-state/` layout.
   *
   * Two safety bounds:
   *   - **Raw read cap** (4 MB by default): if `events.jsonl` exceeds
   *     this, we read only the trailing N bytes and surface a
   *     `truncated.size_limit` marker. Prevents OOM / event-loop
   *     stalls when the agent has been chatty (extreme case observed:
   *     hundreds of MB after a long autonomous run).
   *   - **Per-page limit** (server-enforced via `opts.limit`): the
   *     runtime returns at most that many items.
   *
   * Pagination model (caller-driven, mutually exclusive):
   *   - Neither `before` nor `after` set → tail: latest `limit`
   *     items overall. GUI initial loads use this; the user lands at
   *     the most recent activity without paging through history.
   *   - `after = N` → forward: items with `seq > N`, oldest-first.
   *     Used by SSE polling and by callers walking head-to-tail.
   *   - `before = N` → backward: items with `seq < N`, returns the
   *     `limit` items immediately preceding the cut, still sorted by
   *     `seq` ASC. Used by GUI consumers loading older history when
   *     the user scrolls up past the initial tail-window.
   *   - Both → `RuntimeReadActivityInvalidArgs`. The route layer
   *     should reject before calling the runtime; this is a
   *     defensive guard against in-process callers bypassing the
   *     route.
   *
   * Items are sequenced 0..N-1 across the WHOLE log (not just the
   * returned page) — `seq` is the canonical pagination cursor and
   * matches what `streamActivity` would yield for live tail. Callers
   * derive `hasOlder` / `hasNewer` from the page window
   * (`activity[0].seq > 0`, `activity[last].seq < totalItems - 1`).
   */
  async readActivity(opts: ReadActivityOpts): Promise<ActivityResult | null> {
    if (opts.before !== undefined && opts.after !== undefined) {
      throw new RuntimeReadActivityInvalidArgs("readActivity: `before` and `after` are mutually exclusive");
    }
    const id = safeCopilotId(opts.runtimeSessionId);
    if (id === null) return null;
    const eventsPath = path.join(this.copilotStateDir, id, "events.jsonl");

    let raw: string;
    let truncated: TruncationInfo | undefined;
    try {
      const st = await stat(eventsPath);
      if (st.size > COPILOT_RAW_READ_CAP_BYTES) {
        // Tail-read: open + position to the last N bytes. We may slice
        // the first partial line after the cut; the parser drops it
        // silently (malformed JSON line) and the truncated marker
        // tells the consumer items were dropped.
        const fh = await open(eventsPath, "r");
        try {
          const buf = Buffer.alloc(COPILOT_RAW_READ_CAP_BYTES);
          await fh.read(buf, 0, COPILOT_RAW_READ_CAP_BYTES, st.size - COPILOT_RAW_READ_CAP_BYTES);
          raw = buf.toString("utf8");
          // Drop the (probably partial) first line.
          const firstNewline = raw.indexOf("\n");
          if (firstNewline > 0) raw = raw.slice(firstNewline + 1);
        } finally {
          await fh.close();
        }
        truncated = {
          reason: "size_limit",
          droppedBytes: st.size - COPILOT_RAW_READ_CAP_BYTES,
          hint: `events.jsonl is ${st.size} bytes; read last ${COPILOT_RAW_READ_CAP_BYTES} bytes only. Use task summary endpoint for high-level view.`,
        };
      } else {
        raw = await readFile(eventsPath, "utf8");
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw err;
    }

    const allItems = parseCopilotActivity(raw);
    const totalItems = allItems.length;
    const result = deriveCopilotResult(raw);

    // Apply the pagination window per the model documented above.
    const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
    let filtered: ActivityItem[];
    let pageTruncated: TruncationInfo | undefined;
    if (opts.after !== undefined) {
      // Forward: items strictly after `after`, oldest-first, capped at `limit`.
      const window = allItems.filter((i) => i.seq > (opts.after as number));
      if (limit !== undefined && window.length > limit) {
        filtered = window.slice(0, limit);
        pageTruncated = {
          reason: "page_limit",
          hint: `Showed ${limit} items after seq ${opts.after}; ${window.length - limit} more available — request again with after=${filtered[filtered.length - 1]?.seq}.`,
        };
      } else {
        filtered = window;
      }
    } else if (opts.before !== undefined) {
      // Backward: items strictly before `before`, return the `limit`
      // immediately preceding the cut (i.e., the latest below `before`),
      // still ASC-sorted for caller convenience.
      const window = allItems.filter((i) => i.seq < (opts.before as number));
      if (limit !== undefined && window.length > limit) {
        filtered = window.slice(window.length - limit);
        pageTruncated = {
          reason: "page_limit",
          hint: `Showed ${limit} items before seq ${opts.before}; ${window.length - limit} more available — request again with before=${filtered[0]?.seq}.`,
        };
      } else {
        filtered = window;
      }
    } else {
      // Tail: latest `limit` items. No `limit` set → return everything
      // (CLI default for "give me the whole log").
      if (limit !== undefined && allItems.length > limit) {
        filtered = allItems.slice(allItems.length - limit);
        pageTruncated = {
          reason: "page_limit",
          hint: `Showed last ${limit} of ${allItems.length} items — request again with before=${filtered[0]?.seq} to read older history.`,
        };
      } else {
        filtered = allItems;
      }
    }

    return {
      activity: filtered,
      result,
      totalItems,
      // size_limit (raw-read tail) takes precedence over page_limit
      // when both apply.
      ...(truncated !== undefined
        ? { truncated }
        : pageTruncated !== undefined
          ? { truncated: pageTruncated }
          : {}),
    };
  }

  /**
   * Live-tail variant. Tails `events.jsonl` and yields each new
   * {@link ActivityItem} as it's parseable. Yields nothing on the
   * historical content — call {@link readActivity} for that, then
   * subscribe to this for the live tail (the dashboard pattern).
   *
   * Cleanup: stops on `opts.signal` abort or when the file disappears
   * (workdir purged). Polls fs every {@link COPILOT_TAIL_POLL_MS};
   * a future iteration could use `fs.watch` on supported platforms.
   */
  async *streamActivity(opts: StreamActivityOpts): AsyncIterable<ActivityItem> {
    const id = safeCopilotId(opts.runtimeSessionId);
    if (id === null) return;
    const eventsPath = path.join(this.copilotStateDir, id, "events.jsonl");

    // Establish starting offset: end-of-file at subscription time
    // (we do NOT replay history). Caller gets that via a one-shot
    // readActivity() call beforehand.
    let offset: number;
    let parser: CopilotActivityStreamParser;
    try {
      const st = await stat(eventsPath);
      offset = st.size;
      // Resume at the seq the caller asked for (if any). When omitted,
      // we use the count of items in the historical content as the
      // starting seq so subsequent items continue the sequence.
      const startSeq =
        typeof opts.cursor === "number"
          ? opts.cursor + 1
          : parseCopilotActivity(await readFile(eventsPath, "utf8")).length;
      parser = new CopilotActivityStreamParser(startSeq);
    } catch {
      // File doesn't exist yet (task hasn't started writing). Start
      // from offset 0, seq 0; we'll catch up when it appears.
      offset = 0;
      parser = new CopilotActivityStreamParser(
        typeof opts.cursor === "number" ? opts.cursor + 1 : 0,
      );
    }

    let buffer = "";

    while (true) {
      if (opts.signal?.aborted) return;

      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(eventsPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          // File gone — task purged or workdir removed.
          return;
        }
        throw err;
      }

      if (st.size > offset) {
        const fh = await open(eventsPath, "r");
        try {
          const len = st.size - offset;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, offset);
          buffer += buf.toString("utf8");
          offset = st.size;
        } finally {
          await fh.close();
        }

        // Process complete lines; keep partial trailing line in buffer.
        while (true) {
          const newlineIdx = buffer.indexOf("\n");
          if (newlineIdx === -1) break;
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          const result = parser.parseLine(line);
          for (const item of result.items) {
            if (opts.signal?.aborted) return;
            yield item;
          }
        }
      } else if (st.size < offset) {
        // File was truncated / rewritten (rare — task purge in flight,
        // or external rotation). Treat as end-of-stream.
        return;
      }

      // No new bytes — wait then poll again. The signal abort wins
      // over the timer.
      try {
        await delay(COPILOT_TAIL_POLL_MS, undefined, { signal: opts.signal });
      } catch {
        return;
      }
    }
  }
}

/**
 * Maximum bytes we'll read from `events.jsonl` in one
 * {@link CopilotRuntime.readActivity} call. Sized to comfortably
 * fit a long autonomous run (hundreds of turns) without risking
 * OOM. When exceeded, we tail-read the last N bytes and mark the
 * response truncated.
 */
const COPILOT_RAW_READ_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Poll interval for {@link CopilotRuntime.streamActivity}. 250ms
 * is the upper bound on perceived dashboard latency for live-tail;
 * faster than this risks burning CPU on idle tasks.
 */
const COPILOT_TAIL_POLL_MS = 250;

/**
 * Return the id if it's a syntactically-valid copilot session id, else null.
 * Centralised so refresh/buildInteractiveLaunch/deleteState all defend against tampered
 * persisted state in the same way.
 */
function safeCopilotId(id: string | null): string | null {
  if (id === null) return null;
  return isCopilotSessionId(id) ? id : null;
}
