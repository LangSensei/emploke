import {
  makeFqn,
  splitFqn,
  validateFqn,
  validateScope,
  validateShortName,
} from "../../agent/validate.js";
import { ValueObject } from "../seedwork/value-object.js";

/**
 * Value object: an Agent's fully-qualified name `<scope>/<shortName>`.
 *
 * Identity for the {@link Agent} aggregate root. Validation routes
 * through `agent/validate.ts` so violations raise `AgentNameInvalidError`
 * (parallel to {@link SkillFqn} which raises `SkillNameInvalidError`).
 * The grammar matches `SkillFqn`'s by convention (lowercase kebab +
 * reverse-DNS scope, ≤64 chars per segment), but the two VOs are
 * distinct types so an agent FQN cannot be passed where a skill FQN
 * is expected and vice versa.
 *
 * Behaviour is byte-for-byte unchanged from the prior string-based API.
 */
export class AgentFqn extends ValueObject {
  private constructor(
    private readonly _scope: string,
    private readonly _shortName: string,
  ) {
    super();
  }

  /**
   * Compose an AgentFqn from its parts. Throws `AgentNameInvalidError`
   * on invalid input.
   */
  static create(scope: string, shortName: string): AgentFqn {
    validateScope(scope);
    validateShortName(shortName);
    return new AgentFqn(scope, shortName);
  }

  /** Parse a `<scope>/<shortName>` string. Throws on invalid input. */
  static parse(fqn: string): AgentFqn {
    validateFqn(fqn);
    const { scope, shortName } = splitFqn(fqn);
    return new AgentFqn(scope, shortName);
  }

  get scope(): string {
    return this._scope;
  }
  get shortName(): string {
    return this._shortName;
  }

  /** The canonical `<scope>/<shortName>` string form. */
  override toString(): string {
    return makeFqn(this._scope, this._shortName);
  }

  /** Alias for {@link toString} that signals intent at call sites. */
  toCanonical(): string {
    return this.toString();
  }

  protected override equalityComponents(): readonly unknown[] {
    return [this._scope, this._shortName];
  }
}
