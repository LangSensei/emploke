/**
 * Test-only entry point: in-memory `SessionRepository` implementation
 * for callers that want to skip filesystem orchestration in their unit
 * tests.
 */

export { InMemorySessionRepository } from "./repositories/in-memory-session-repository.js";
