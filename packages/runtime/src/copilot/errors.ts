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
 * Thrown by {@link assertCopilotSdkResolvable} (the server-bootstrap
 * preflight) when `@github/copilot-sdk` or its transitive
 * `@github/copilot` CLI dep cannot be resolved from the running
 * process's module graph.
 *
 * The message intentionally carries the install hint and the underlying
 * Node `ERR_MODULE_NOT_FOUND` chain so operators see exactly what's
 * missing without having to grep server logs.
 *
 * This is a boot-time configuration error: the publishing pipeline
 * shipped a bundle whose runtime dep wasn't declared in the published
 * `package.json` (issue tracked in `fix/copilot-sdk-packaging-chain`),
 * or the operator manually deleted the SDK from `node_modules` after
 * install. Either way, every `tasks.dispatch` against the copilot
 * runtime would otherwise fail silently with `HTTP 400 internal error`
 * and no server log entry — surface it loudly at startup instead.
 */
export class CopilotSdkUnavailableError extends Error {
  constructor(cause: Error) {
    super(
      [
        "copilot runtime requires @github/copilot-sdk (and its @github/copilot CLI dep).",
        "Install via: npm install -g @github/copilot-sdk",
        `Detail: ${cause.message}`,
      ].join("\n"),
    );
    this.name = "CopilotSdkUnavailableError";
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
