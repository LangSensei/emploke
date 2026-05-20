import { splitMcpName, validateMcpName } from "../../mcp/validate.js";
import { ValueObject } from "../seedwork/value-object.js";

/**
 * Value object: an MCP spec name `<namespace>/<shortName>`.
 *
 * Identity for the {@link Mcp} aggregate root. The grammar is fixed
 * by the MCP spec, not by emploke's storage layout, and is **looser**
 * than catalog's `<scope>/<shortName>` FQN — segment characters
 * follow `validateMcpName`'s rules (no whitespace, no control chars,
 * no `\\`, no `.` / `..` segments, ≤200 chars total). For that reason
 * `McpName` is intentionally distinct from {@link SkillFqn} /
 * {@link AgentFqn}: a name that parses for MCP may not parse for skill,
 * and a SkillFqn must never be passed to an MCP API.
 *
 * Behaviour is byte-for-byte unchanged from the prior string-based
 * `validateMcpName` + `splitMcpName` API.
 */
export class McpName extends ValueObject {
  private constructor(
    private readonly _namespace: string,
    private readonly _shortName: string,
  ) {
    super();
  }

  /** Parse a raw `<namespace>/<shortName>` string. Throws `McpNameInvalidError`. */
  static parse(name: string): McpName {
    validateMcpName(name);
    const { namespace, shortName } = splitMcpName(name);
    return new McpName(namespace, shortName);
  }

  /**
   * Compose an McpName from its parts. Throws `McpNameInvalidError`
   * if the joined `<namespace>/<shortName>` would not pass
   * {@link validateMcpName}.
   */
  static create(namespace: string, shortName: string): McpName {
    const joined = `${namespace}/${shortName}`;
    validateMcpName(joined);
    return new McpName(namespace, shortName);
  }

  get namespace(): string {
    return this._namespace;
  }
  get shortName(): string {
    return this._shortName;
  }

  /** The canonical `<namespace>/<shortName>` string form. */
  override toString(): string {
    return `${this._namespace}/${this._shortName}`;
  }

  /** Alias for {@link toString} that signals intent at call sites. */
  toCanonical(): string {
    return this.toString();
  }

  protected override equalityComponents(): readonly unknown[] {
    return [this._namespace, this._shortName];
  }
}
