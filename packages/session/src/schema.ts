import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

/**
 * Persisted session row. Carries only the slice that survives across
 * server lifetimes (runtime kind, agent FQN, optional runtime session
 * id, last launch mode). Live activity (lastActiveAt / preview /
 * workdir) is recomputed per call by SessionManager from the runtime
 * registry + workspace layout.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    agent: text("agent").notNull(),
    runtime: text("runtime").notNull(),
    createdAt: text("created_at").notNull(),
    runtimeSessionId: text("runtime_session_id"),
    lastLaunchMode: text("last_launch_mode", { enum: ["local", "remote"] }),
  },
  (t) => [index("sessions_agent_idx").on(t.agent)],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
