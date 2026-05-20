import {
  makeFqn,
  splitFqn,
  validateFqn,
  validateScope,
  validateShortName,
} from "../../skill/validate.js";
import { ValueObject } from "../seedwork/value-object.js";

/**
 * Value object: a Skill's fully-qualified name `<scope>/<shortName>`.
 *
 * Identity for the {@link Skill} aggregate root. Construction enforces
 * the catalog's FQN grammar (lowercase kebab + reverse-DNS scope, ≤64
 * chars per segment); existing free-form `validateFqn` /
 * `validateShortName` / `validateScope` underpin the parse so behaviour
 * is byte-for-byte unchanged from the prior string-based API.
 *
 * ## Why a separate VO from {@link AgentFqn}?
 *
 * Skill and Agent FQNs share grammar today, but they are distinct
 * domain concepts with separate aggregates and separate repositories.
 * Treating them as one polymorphic VO would invite accidental cross
 * passing (e.g. an agent FQN slipping into a skill repo). Separate
 * VO types are a compile-time guard against that mistake (per
 * critique #6 of the PR-1 design review).
 *
 * ## Why a separate VO from {@link McpName}?
 *
 * MCP names follow the MCP spec's grammar (looser segment rules,
 * 200-char total limit), not catalog's FQN grammar. They are not
 * interchangeable.
 */
export class SkillFqn extends ValueObject {
  private constructor(
    private readonly _scope: string,
    private readonly _shortName: string,
  ) {
    super();
  }

  /**
   * Compose a SkillFqn from its parts. Throws `SkillNameInvalidError`
   * (the existing error class on {@link validateScope} / {@link validateShortName})
   * on invalid input.
   */
  static create(scope: string, shortName: string): SkillFqn {
    validateScope(scope);
    validateShortName(shortName);
    return new SkillFqn(scope, shortName);
  }

  /**
   * Parse a `<scope>/<shortName>` string. Throws `SkillNameInvalidError`
   * on invalid input.
   */
  static parse(fqn: string): SkillFqn {
    validateFqn(fqn);
    const { scope, shortName } = splitFqn(fqn);
    return new SkillFqn(scope, shortName);
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
