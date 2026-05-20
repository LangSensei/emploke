import { parseOrigin } from "@emploke/catalog-fetcher";
import { ValueObject } from "../seedwork/value-object.js";

/**
 * Value object: a catalog entry's install-source URI.
 *
 * Origin is the canonical "where did this entry come from?" attribute
 * shared by all three aggregates (`Mcp`, `Skill`, `Agent`). It is
 * **provenance**, not identity (identity is the FQN / name); two
 * entries with different FQNs may share an origin (a single git tree
 * containing multiple skills), and a rename of the FQN is modelled as
 * delete + reinstall, not as an Origin change.
 *
 * Construction routes through `parseOrigin` from
 * `@emploke/catalog-fetcher` so the fetcher remains the single source
 * of truth for origin grammar  a malformed URI that the fetcher
 * would reject must also be rejected here.
 *
 * ## Why no normalisation in this VO (PR-1 design choice)
 *
 * `parseOrigin` + `normalizeOrigin` together can canonicalise URIs
 * (lowercase scheme, trim trailing slashes, scheme-specific
 * canonicalisation). PR-1 deliberately stores the **raw** input
 * string verbatim so `origin.value` round-trips byte-for-byte with
 * what the caller passed in. Reasons:
 *   - Existing storage rows are unnormalised; canonicalising here
 *     would silently rewrite their origins on the first read.
 *   - Existing tests assert raw round-trip; switching to
 *     normalisation would be a behaviour change disguised as a
 *     "foundation" PR.
 * Equality of the VO is therefore raw-string equality. PR-2+ can
 * introduce a deliberate canonicalisation step (with migration +
 * test updates) once it can be co-designed with persistence and
 * downstream callers.
 *
 * ## Why no `isMutable()` method on this VO
 *
 * Mutability ("can the catalog mutate this entry's stored content?")
 * is a **policy** decision today (Phase 2 rule: `file:` only) that
 * may move into per-fetcher capability flags later. Putting policy
 * on the VO makes the policy look intrinsic to the value, couples
 * the VO to a specific feature, and frustrates substitution. The
 * existing `isOriginMutable(origin: string)` standalone function
 * remains the public mutability check.
 */
export class Origin extends ValueObject {
  private constructor(
    /** Raw input string, byte-for-byte (see class jsdoc). */
    private readonly _value: string,
    /** Parsed scheme  e.g. `file`, `github`. Cached at construction. */
    private readonly _scheme: string,
  ) {
    super();
  }

  /**
   * Parse a raw origin URI. Throws `OriginParseError` (re-exported
   * from `@emploke/catalog-fetcher`) on garbled input.
   */
  static parse(raw: string): Origin {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new TypeError("Origin.parse requires a non-empty string");
    }
    const parsed = parseOrigin(raw);
    return new Origin(raw, parsed.scheme);
  }

  /** The raw input string, verbatim. */
  get value(): string {
    return this._value;
  }

  /** Parsed scheme of the origin (e.g. `"file"`, `"github"`). */
  get scheme(): string {
    return this._scheme;
  }

  /** Raw input string. */
  override toString(): string {
    return this._value;
  }

  protected override equalityComponents(): readonly unknown[] {
    return [this._value];
  }
}
