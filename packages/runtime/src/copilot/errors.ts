/**
 * Errors specific to the Copilot runtime. Generic runtime errors live in
 * `../errors.ts`.
 */

/**
 * Thrown when an MCP server config (or the `.mcp.json` file that contains
 * it) is invalid — either unparseable as JSON, or parsed JSON whose shape
 * violates the `{ mcpServers: { name: serverConfig, ... } }` contract.
 *
 * `mcpName` carries the offending server's FQN for per-server failures
 * (catalog-source resolution in `provision.ts`, or per-entry shape checks
 * in `launch-headless.ts`'s `readMcpServersFromWorkdir`) or the literal
 * `".mcp.json"` for whole-file failures (top-level parse or top-level
 * shape failure of the workdir's `.mcp.json`).
 *
 * Catalog scan validates JSON at install time, so per-server parse
 * failures normally indicate corruption or an out-of-band edit between
 * scan and provision. Whole-file failures of the provisioned `.mcp.json`
 * similarly indicate an out-of-band edit between `provision` and
 * `launchHeadless`.
 */
export class InvalidMcpJson extends Error {
  constructor(
    public readonly mcpName: string,
    cause: Error,
  ) {
    super(`MCP "${mcpName}" config is invalid: ${cause.message}`);
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
 * `package.json`, or the operator manually deleted the SDK from
 * `node_modules` after install. Either way, every `tasks.dispatch`
 * against the copilot runtime would otherwise fail silently with
 * `HTTP 400 internal error` and no server log entry — surface it
 * loudly at startup instead.
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
