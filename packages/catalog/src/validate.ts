import { NameInvalid } from "./errors.js";

/** kebab-case: lowercase letters + digits, single hyphens between groups, must start with a letter. */
const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new NameInvalid(String(name), "must be a non-empty string");
  }
  if (!KEBAB_CASE.test(name)) {
    throw new NameInvalid(
      name,
      "must be kebab-case (lowercase letters, digits, single hyphens, must start with a letter)",
    );
  }
}
