import path from "node:path";

/**
 * Subdirectory (under `<home>`) used by runtime adapters as the resolved
 * value for the `${sharedDir}` MCP placeholder. Stable per-machine path
 * shared across every workspace and runtime — spec authors get to write
 * `${sharedDir}/some-state.db` without baking host paths into JSON.
 *
 * Lives in the runtime pkg because `${sharedDir}` is a runtime-adapter
 * concept (used by the placeholder substitution in MCP spec materialisation).
 * Cross-pkg consumers receive the resolved path via dependency injection,
 * not by importing this helper.
 */
export const SHARED_SUBDIR = "shared";

/** Resolve `<home>/shared/`. */
export function sharedDir(home: string): string {
  return path.join(home, SHARED_SUBDIR);
}
