import * as McpFormat from "./mcp-format.js";
import { validateMcpName } from "./validate.js";

/**
 * Rich domain entity representing a single installed MCP.
 *
 * Identity = (name, origin), both immutable.
 *
 *   - `name` is the MCP-spec FQN (`<namespace>/<short>`, e.g. `azure/mcp`).
 *     We keep this term ("name") because it's the term the MCP spec uses;
 *     unlike skills/agents — where emploke adds a `scope:` segment so we
 *     introduce `fqn` to distinguish — MCP spec names ARE globally
 *     unique-by-convention and need no extra namespacing layer.
 *   - `origin` is the install-source URI.
 *
 * Construction goes through factories, never the constructor directly:
 *   - {@link Mcp.create} — for fresh installs from raw user bytes.
 *   - {@link Mcp.fromStored} — for reconstitution by the repository.
 *
 * Invariants:
 *   - `name` matches MCP spec grammar (validated via `validateMcpName`)
 *   - `origin` is non-empty
 *   - `content` is JSON parseable as `{ _meta: { name, origin }, ... }`
 *     where `_meta.name === this.name` and `_meta.origin === this.origin`
 */
export class Mcp {
  private constructor(
    private readonly _name: string,
    private readonly _origin: string,
    private readonly _content: string,
  ) {}

  static create(name: string, origin: string, rawContent: string): Mcp {
    validateMcpName(name);
    if (typeof origin !== "string" || origin.length === 0) {
      throw new TypeError("Mcp.create requires a non-empty origin string");
    }
    const sourceLabel = `mcps:${name}`;
    const merged = McpFormat.writeMeta(rawContent, { name, origin }, sourceLabel);
    // Defensive: re-parse so we never construct an entity whose content
    // can't be read back. Catches programmer errors in writeMeta upgrades.
    McpFormat.parse(merged, sourceLabel);
    return new Mcp(name, origin, merged);
  }

  static fromStored(name: string, origin: string, content: string): Mcp {
    validateMcpName(name);
    return new Mcp(name, origin, content);
  }

  get name(): string {
    return this._name;
  }

  get origin(): string {
    return this._origin;
  }

  get content(): string {
    return this._content;
  }

  /** Plain JSON projection. */
  toJSON(): Record<string, unknown> {
    return {
      name: this._name,
      origin: this._origin,
    };
  }

  /**
   * Return a new entity with replaced content. Identity (name, origin)
   * is preserved — the entity's stable name/origin are re-injected
   * into the new content's `_meta`. Callers cannot change identity via
   * this method; they must delete + reinstall.
   */
  withContent(rawContent: string): Mcp {
    return Mcp.create(this._name, this._origin, rawContent);
  }
}
