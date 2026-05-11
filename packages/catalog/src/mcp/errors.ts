/**
 * MCP-specific error types. All errors in this package extend `Error`
 * with a stable `name` so HTTP transport layers can map them to status
 * codes without instanceof imports.
 */

abstract class McpError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/** Thrown when an MCP spec name violates the format rules. */
export class McpNameInvalidError extends McpError {
  constructor(
    public readonly mcpName: string,
    reason: string,
  ) {
    super(`invalid MCP name "${mcpName}": ${reason}`);
  }
}

/** Thrown when looking up an MCP that doesn't exist. */
export class McpNotFoundError extends McpError {
  constructor(public readonly mcpName: string) {
    super(`MCP not found: ${mcpName}`);
  }
}

/**
 * Thrown when reinstalling an existing MCP under a different origin.
 * Identity (name) collisions across origins are rejected — to switch
 * origins, the caller must explicitly delete then reinstall.
 */
export class McpOriginConflictError extends McpError {
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
export class McpInvalidJsonError extends McpError {
  constructor(
    public readonly sourceLabel: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`invalid MCP JSON (${sourceLabel}): ${reason}`, options);
  }
}
