/**
 * Test-only entry point: in-memory `WorkspaceRepository` implementation
 * for callers that want to skip filesystem orchestration in their unit
 * tests. Importing from `@emploke/workspace/testing` makes the test-only
 * intent explicit at the call site.
 */

export { InMemoryWorkspaceRepository } from "./repositories/in-memory-workspace-repository.js";
