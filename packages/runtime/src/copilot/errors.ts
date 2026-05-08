/**
 * Errors specific to the Copilot runtime. Generic runtime errors live in
 * `../errors.ts`.
 */

/**
 * Thrown when an MCP file referenced by the resolve result cannot be parsed
 * as JSON. Catalog scan validates JSON at install time, so this normally
 * indicates corruption or out-of-band edits between scan and provision.
 */
export class InvalidMcpJson extends Error {
  constructor(
    public readonly mcpName: string,
    public readonly mcpPath: string,
    cause: Error,
  ) {
    super(`MCP "${mcpName}" at ${mcpPath} is not valid JSON: ${cause.message}`);
    this.name = "InvalidMcpJson";
    this.cause = cause;
  }
}

/**
 * Thrown when the per-runtime workspace preparation step fails (e.g.
 * `git init`). Wraps the underlying spawn or exit error.
 */
export class WorkspacePrepFailed extends Error {
  constructor(
    public readonly step: string,
    public readonly targetDir: string,
    cause: Error,
  ) {
    super(`workspace preparation step "${step}" failed in ${targetDir}: ${cause.message}`);
    this.name = "WorkspacePrepFailed";
    this.cause = cause;
  }
}
