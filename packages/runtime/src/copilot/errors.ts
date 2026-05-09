/**
 * Errors specific to the Copilot runtime. Generic runtime errors live in
 * `../errors.ts`.
 */

/**
 * Thrown when an MCP server config retrieved from the catalog cannot be
 * parsed as JSON. Catalog scan validates JSON at install time, so this
 * normally indicates corruption or an out-of-band edit between scan and
 * provision.
 */
export class InvalidMcpJson extends Error {
  constructor(
    public readonly mcpName: string,
    cause: Error,
  ) {
    super(`MCP "${mcpName}" is not valid JSON: ${cause.message}`);
    this.name = "InvalidMcpJson";
    this.cause = cause;
  }
}

/**
 * Thrown when the per-session workdir preparation step fails (e.g.
 * `git init`). Wraps the underlying spawn or exit error.
 *
 * Renamed from `WorkspacePrepFailed` so the term "workspace" is reserved
 * for the new project-level concept managed by `@emploke/workspace`. This
 * error covers per-session workdir prep, not workspace prep.
 */
export class WorkdirPrepFailed extends Error {
  constructor(
    public readonly step: string,
    public readonly workdir: string,
    cause: Error,
  ) {
    super(`workdir preparation step "${step}" failed in ${workdir}: ${cause.message}`);
    this.name = "WorkdirPrepFailed";
    this.cause = cause;
  }
}

/**
 * Thrown when `CopilotRuntime.registerWorkspace` fails to persist a trust
 * entry into the Copilot CLI's settings file. This happens before any
 * sessions can run inside the workspace; without it the spawned `copilot`
 * CLI would interrupt the user with a per-folder trust prompt.
 */
export class TrustRegistrationFailed extends Error {
  constructor(
    public readonly settingsPath: string,
    public readonly workspaceDir: string,
    cause: Error,
  ) {
    super(`failed to register workspace ${workspaceDir} in ${settingsPath}: ${cause.message}`);
    this.name = "TrustRegistrationFailed";
    this.cause = cause;
  }
}
