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
 * Thrown when ensuring trust on the Copilot CLI's `config.json` (the
 * file the CLI actually reads `trustedFolders` from — see `trust.ts`
 * for why this is `config.json` and not `settings.json`) fails.
 *
 * Surfaced from `CopilotRuntime.buildInteractiveLaunch` as part of the per-launch
 * trust preflight: an interactive (`-i`) Copilot session that runs in a
 * folder not covered by `trustedFolders` would stall on the blocking
 * "Confirm folder trust" prompt inside the freshly-spawned terminal.
 * Failing the launch up front (and surfacing this error in the
 * dashboard) is much better UX than silently spawning into that prompt.
 *
 * The SDK headless path used by `launchCopilotHeadless` is unaffected
 * because it has no folder-trust gate (the SDK's `approveAll` permission
 * handler bypasses it).
 */
export class TrustRegistrationFailed extends Error {
  constructor(
    public readonly configPath: string,
    public readonly workspaceDir: string,
    cause: Error,
  ) {
    super(`failed to ensure ${workspaceDir} is trusted in ${configPath}: ${cause.message}`);
    this.name = "TrustRegistrationFailed";
    this.cause = cause;
  }
}
