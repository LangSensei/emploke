import * as McpFormat from "./mcp-format.js";
import { validateMcpName } from "./validate.js";

/**
 * Rich domain entity representing a single installed MCP.
 *
 * Identity = (fqn, origin), both immutable. Schema v2 (issue #122):
 * the storage column was renamed `name` → `fqn` and `content` → `spec`
 * for catalog-wide terminology consistency. The MCP spec's `_meta.name`
 * wire field is unaffected — only the storage/API surface uses `fqn`.
 *
 *   - `fqn` is the MCP-spec FQN (`<namespace>/<short>`, e.g. `azure/mcp`).
 *     MCP spec names ARE globally unique-by-convention; emploke does not
 *     add a separate `scope:` segment for them.
 *   - `spec` carries the raw JSON spec bytes (renamed from `content`).
 *   - `installedAt` / `updatedAt` ISO 8601 UTC timestamps surface here so
 *     DTO projections can include them.
 */
export class Mcp {
  private constructor(
    private readonly _fqn: string,
    private readonly _origin: string,
    private readonly _spec: string,
    private readonly _installedAt: string,
    private readonly _updatedAt: string,
  ) {}

  static create(name: string, origin: string, rawContent: string): Mcp {
    validateMcpName(name);
    if (typeof origin !== "string" || origin.length === 0) {
      throw new TypeError("Mcp.create requires a non-empty origin string");
    }
    const sourceLabel = `mcps:${name}`;
    const merged = McpFormat.writeMeta(rawContent, { name }, sourceLabel);
    McpFormat.parse(merged, sourceLabel);
    const now = new Date().toISOString();
    return new Mcp(name, origin, merged, now, now);
  }

  static fromStored(
    fqn: string,
    origin: string,
    spec: string,
    installedAt: string,
    updatedAt: string,
  ): Mcp {
    validateMcpName(fqn);
    return new Mcp(fqn, origin, spec, installedAt, updatedAt);
  }

  get fqn(): string {
    return this._fqn;
  }
  get origin(): string {
    return this._origin;
  }
  get spec(): string {
    return this._spec;
  }
  get installedAt(): string {
    return this._installedAt;
  }
  get updatedAt(): string {
    return this._updatedAt;
  }

  /** Plain JSON projection. */
  toJSON(): Record<string, unknown> {
    return {
      fqn: this._fqn,
      origin: this._origin,
      installedAt: this._installedAt,
      updatedAt: this._updatedAt,
    };
  }

  /**
   * Return a new entity with replaced spec bytes; identity preserved,
   * `updatedAt` bumped. Callers cannot change identity via this method.
   */
  withContent(rawContent: string): Mcp {
    const sourceLabel = `mcps:${this._fqn}`;
    const merged = McpFormat.writeMeta(rawContent, { name: this._fqn }, sourceLabel);
    McpFormat.parse(merged, sourceLabel);
    return new Mcp(this._fqn, this._origin, merged, this._installedAt, new Date().toISOString());
  }
}
