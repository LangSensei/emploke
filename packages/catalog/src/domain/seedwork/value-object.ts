/**
 * Base class for every domain value object in `@emploke/catalog`.
 *
 * Mirrors workspace's seedwork `ValueObject` (which mirrors eShop's
 * `Ordering.Domain/SeedWork/ValueObject.cs`). A value object has
 * **no identity** — equality is purely structural, computed from a
 * tuple of "equality components" the subclass declares. Two
 * `SkillFqn(scope='public', short='tool-use')` instances are equal
 * even though they are different object references; cf. {@link Entity},
 * where equality is by id.
 *
 * ## Subclass contract
 *
 * Override {@link equalityComponents} to return the ordered tuple of
 * primitives / VOs that define this VO's identity. Single-field
 * wrappers return `[this.value]`; composite VOs return all fields in
 * a stable order.
 *
 * ## Why no `getHashCode`
 *
 * eShop's `ValueObject.GetHashCode` exists because .NET dictionaries
 * + sets need stable hashes. JS `Map` / `Set` use reference equality
 * by default, and we don't store VOs in keyed collections — equality
 * checks happen via explicit `.equals(...)` calls. Skipping the hash
 * keeps the API smaller and avoids surprising mismatches between
 * `===` and a hypothetical `hashCode`.
 */
export abstract class ValueObject {
  /**
   * Ordered list of values that define this VO's identity. Used by
   * {@link equals}; subclasses must return the same components for
   * the same logical value.
   */
  protected abstract equalityComponents(): readonly unknown[];

  /**
   * Structural equality. Two VOs are equal iff they have the same
   * concrete type and their {@link equalityComponents} match
   * positionally. Components that are themselves VOs are compared
   * via their own `equals` (not `===`).
   */
  equals(other: unknown): boolean {
    if (this === other) return true;
    if (!(other instanceof ValueObject)) return false;
    if (this.constructor !== other.constructor) return false;
    const a = this.equalityComponents();
    const b = other.equalityComponents();
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!componentEquals(a[i], b[i])) return false;
    }
    return true;
  }
}

function componentEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof ValueObject && b instanceof ValueObject) return a.equals(b);
  return false;
}
