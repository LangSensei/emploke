/**
 * MCP-specific error types. All errors extend native `Error` with a
 * stable `name` field so HTTP transport layers can map them to status
 * codes without instanceof imports across package boundaries.
 *
 * No shared abstract base — each class sets `name` in its own field
 * initialiser.
 */

/** Thrown when an MCP spec name violates the format rules. */
export class McpNameInvalidError extends Error {
  override readonly name = "McpNameInvalidError";

  constructor(
    public readonly mcpName: string,
    reason: string,
  ) {
    super(`invalid MCP name "${mcpName}": ${reason}`);
  }
}

/** Thrown when looking up an MCP that doesn't exist. */
export class McpNotFoundError extends Error {
  override readonly name = "McpNotFoundError";

  constructor(public readonly mcpName: string) {
    super(`MCP not found: ${mcpName}`);
  }
}

/**
 * Thrown when reinstalling an existing MCP under a different origin.
 * Identity (name) collisions across origins are rejected — to switch
 * origins, the caller must explicitly delete then reinstall.
 */
export class McpOriginConflictError extends Error {
  override readonly name = "McpOriginConflictError";

  constructor(
    public readonly mcpName: string,
    public readonly existingOrigin: string,
    public readonly attemptedOrigin: string,
  ) {
    super(
      `MCP "${mcpName}" is already installed from "${existingOrigin}"; ` +
        `refusing to overwrite with origin "${attemptedOrigin}". ` +
        "Delete and reinstall to switch origins.",
    );
  }
}

/** Thrown when raw bytes can't be parsed as a valid MCP JSON file. */
export class McpInvalidJsonError extends Error {
  override readonly name = "McpInvalidJsonError";

  constructor(
    public readonly sourceLabel: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`invalid MCP JSON (${sourceLabel}): ${reason}`, options as ErrorOptions);
  }
}
