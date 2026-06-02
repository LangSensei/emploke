import { randomUUID } from "node:crypto";

/**
 * Copilot's session id is a UUID. The CLI accepts any 8-4-4-4-12 hex string
 * (it doesn't strictly require v4), so we widen the regex slightly to match
 * what `copilot --session-id=<id>` will tolerate.
 */
export const COPILOT_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCopilotSessionId(s: unknown): s is string {
  return typeof s === "string" && COPILOT_SESSION_ID_RE.test(s);
}

/**
 * Generate a fresh copilot session id. Pre-allocated at provision time and
 * passed via `--session-id=<id>` to the first launch — the CLI documents that
 * `--session-id` "starts a new session with a specific UUID if one does not
 * exist", which is exactly the behavior we want.
 *
 * Injectable for deterministic tests.
 */
export function generateCopilotSessionId(rng: () => string = randomUUID): string {
  const id = rng();
  if (!isCopilotSessionId(id)) {
    throw new Error(`generated id is not a valid copilot session id: ${id}`);
  }
  return id;
}

/**
 * Null-aware variant of `isCopilotSessionId`. Returns the id when it
 * passes validation, null when the id is null or malformed. The
 * CopilotRuntime methods that compose `runtimeSessionId` into a
 * filesystem path or a `--session-id=<id>` argument
 * (`readMetadata`, `readActivity`, `streamActivity`, `deleteState`,
 * `buildInteractiveLaunch`) call this first, so a tampered persisted id
 * degrades gracefully (no path traversal, no shell injection) rather
 * than throwing.
 *
 * Package-private — used by `copilot-runtime.ts` for its
 * tampered-id defence but intentionally not re-exported from
 * the `@emploke/runtime` barrel; external consumers should
 * validate via `isCopilotSessionId` instead.
 */
export function safeCopilotId(id: string | null): string | null {
  if (id === null) return null;
  return isCopilotSessionId(id) ? id : null;
}
