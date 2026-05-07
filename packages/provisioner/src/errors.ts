export class ProvisionError extends Error {
  override readonly name: string = "ProvisionError";
}

/**
 * Thrown when an MCP file referenced by the resolve result cannot be parsed
 * as JSON. Catalog scan validates JSON at install time, so this normally
 * indicates corruption or out-of-band edits between scan and provision.
 */
export class InvalidMcpJson extends ProvisionError {
  override readonly name = "InvalidMcpJson";

  constructor(
    readonly mcpName: string,
    readonly path: string,
    override readonly cause: Error,
  ) {
    super(`MCP "${mcpName}" at ${path} is not valid JSON: ${cause.message}`);
  }
}

/**
 * Thrown when the per-provider workspace preparation step fails (e.g.
 * `git init` for Copilot). Wraps the underlying spawn or exit error.
 */
export class WorkspacePrepFailed extends ProvisionError {
  override readonly name = "WorkspacePrepFailed";

  constructor(
    readonly step: string,
    readonly targetDir: string,
    override readonly cause: Error,
  ) {
    super(`workspace preparation step "${step}" failed in ${targetDir}: ${cause.message}`);
  }
}
