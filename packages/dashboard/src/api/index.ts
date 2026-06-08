// Aggregate re-export surface for the dashboard's HTTP client.
//
// History: `packages/dashboard/src/api.ts` carried the entire client
// in a single 1394-line file (TN-B F1-1). This index.ts preserves
// the legacy `import { ... } from "../api"` path while the actual
// definitions live in per-domain siblings below.
//
// Every existing consumer import (`from "../api"`, `from "../../api"`,
// `from "../api.js"`, etc.) MUST resolve to a symbol re-exported here.
// Add new exports to the matching domain file; this index file is
// pure aggregation — no logic, no types.
//
// `http.js` is intentionally re-exported by NAME (not blanket
// `export *`): it holds 7 transport helpers (`fetchJson`, `mutate`,
// `mutateJson`, `extractError`, `jsonInit`, `workspacePrefix`,
// `fetchJsonWithErrorBody`) that were module-local `const`s in the
// pre-split `api.ts` — i.e. private. Sibling domain files still
// import them directly from `./http.js`; only the active-workspace
// pair is part of the public surface.

export * from "./catalog.js";
export { getActiveWorkspace, setActiveWorkspace } from "./http.js";
export * from "./schedules.js";
export * from "./sessions.js";
export * from "./system.js";
export * from "./tasks.js";
export * from "./workflows.js";
export * from "./workspaces.js";
