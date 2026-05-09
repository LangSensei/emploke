/**
 * Test-only entry point: in-memory `TaskRepository` implementation
 * for callers that want to skip filesystem orchestration in their unit
 * tests.
 */

export { InMemoryTaskRepository } from "./repositories/in-memory-task-repository.js";
