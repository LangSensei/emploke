import type { Catalog } from "@emploke/catalog";
import type { RuntimeRegistry, Session } from "@emploke/runtime";

/** Optional logger surface. Default implementation is silent. */
export interface Logger {
  warn(message: string, meta?: object): void;
}

/** Configuration for SessionManager. All fields are optional except `catalog` + `runtimeRegistry`. */
export interface SessionManagerConfig {
  /** Catalog used to resolve agents at create() time. */
  readonly catalog: Catalog;
  /** Registry of runtime adapters; must contain at least the default runtime. */
  readonly runtimeRegistry: RuntimeRegistry;
  /** Runtime kind used by `create()` when none is supplied. Defaults to `"copilot"`. */
  readonly defaultRuntime?: string;
  /** Root directory for session workdirs. Defaults to `~/.emploke/sessions`. */
  readonly root?: string;
  /** Optional logger. Defaults to silent. */
  readonly logger?: Logger;
  /** Test seam: clock for ID generation. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Test seam: random byte source for ID generation. Defaults to `crypto.randomBytes`. */
  readonly randomBytes?: (n: number) => Buffer;
}

/** Re-export the runtime view of a session as the canonical session record. */
export type { LaunchCommand, Session } from "@emploke/runtime";

/**
 * The on-disk shape persisted at `<workdir>/session.json`. Narrow on purpose:
 *
 *   - `id` is NOT persisted (it equals `path.basename(workdir)`).
 *   - `agent` is NOT persisted (it lives in `AGENTS.md` frontmatter, which
 *     the user is expected to be able to hand-edit).
 *   - `lastActiveAt` and `preview` are NOT persisted; they're refreshed from
 *     the runtime on every list/get call.
 *
 * Bumping `schemaVersion` is the migration path for future schema changes.
 */
export interface PersistedSession {
  readonly schemaVersion: 1;
  readonly runtime: string;
  /** ISO 8601 string. */
  readonly createdAt: string;
  /** Opaque-to-emploke id minted by the runtime. May be null until first launch. */
  readonly runtimeSessionId: string | null;
}

/** Options for SessionManager.create. */
export interface CreateSessionOpts {
  /** Catalog agent name. */
  readonly agent: string;
  /**
   * Runtime kind to use. Defaults to `SessionManagerConfig.defaultRuntime`,
   * which itself defaults to `"copilot"`.
   */
  readonly runtime?: string;
}

/** Options for SessionManager.list. */
export interface ListSessionOpts {
  /** Filter to sessions whose AGENTS.md frontmatter name matches this exact value. */
  readonly agent?: string;
  /**
   * Drop sessions whose `createdAt` is strictly before this ISO 8601 timestamp.
   * Applied AFTER reading session.json + AGENTS.md but BEFORE the (more expensive)
   * runtime.refresh() call, so excluded entries pay zero refresh cost.
   */
  readonly createdSince?: string;
}

/** Options for SessionManager.delete. */
export interface DeleteSessionOpts {
  /**
   * If true, ask the runtime to also remove its own per-session state (e.g.
   * for copilot, this is `~/.copilot/session-state/<runtimeSessionId>/`).
   * Performed *before* the workdir is removed; a runtime failure leaves the
   * workdir intact so the user can retry.
   */
  readonly deleteRuntimeState?: boolean;
}

/** Re-exported for callers that want to type-narrow. */
export type { Session as SessionRecord } from "@emploke/runtime";

// Internal helper used by tests and consumers; alias for parity with Runtime.
export type ManagedSession = Session;
