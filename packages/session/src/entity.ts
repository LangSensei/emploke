import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

/**
 * Persisted session row. Carries only the slice that survives across
 * server lifetimes (runtime adapter kind, the agent FQN provisioned at
 * create time, the optional opaque id the runtime minted for its own
 * per-session state, and the user's last launch-mode choice). Live
 * activity (lastActiveAt / preview / workdir) is recomputed per call by
 * `SessionManager` from the runtime registry + the workspace layout.
 *
 * No factories, no value objects, no domain methods. The manager
 * constructs / mutates fields directly inside `em.transactional(...)`.
 */
@Entity({ tableName: "sessions" })
export class Session {
  @PrimaryKey({ type: "text" })
  id!: string;

  /**
   * Agent FQN (`<scope>/<name>`) this session was provisioned with.
   * Persisted at create time; manual edits to AGENTS.md after provision
   * do not propagate (frozen-on-create, same semantics as `task.agent`).
   */
  @Property({ type: "text" })
  @Index({ name: "sessions_agent_idx" })
  agent!: string;

  /** Runtime adapter kind (e.g. `"copilot"`, `"gemini"`). */
  @Property({ type: "text" })
  runtime!: string;

  /** ISO 8601 UTC timestamp at session creation. */
  @Property({ type: "text", fieldName: "created_at" })
  createdAt!: string;

  /**
   * Opaque id minted by the runtime for its own per-session state.
   * `null` when not yet known (discovery-only runtimes that lazy-mint).
   */
  @Property({ type: "text", fieldName: "runtime_session_id", nullable: true })
  runtimeSessionId!: string | null;

  /**
   * Mode the user chose for the most recent successful launch of this
   * session. `null` when never launched. Defaults the dashboard's
   * Resume button to the user's last intent.
   */
  @Property({ type: "text", fieldName: "last_launch_mode", nullable: true })
  lastLaunchMode!: "local" | "remote" | null;
}

/** Entities array for `MikroORM.init({ entities: ... })`. */
export const SESSION_ENTITIES = [Session] as const;
