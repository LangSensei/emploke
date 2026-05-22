/**
 * Error hierarchy for `@emploke/__PKG__`. All errors extend
 * {@link __Entity__Error} so callers can `instanceof` a coarse check
 * within the same realm; cross-realm callers (HTTP routes, CLI) should
 * branch on the stable `name` string literal instead — bundlers can
 * split the class definition.
 *
 * Convention: every subclass declares `override readonly name = "..."`
 * with a literal string equal to the class name. Do NOT use
 * `this.name = new.target.name` (dynamic; breaks under name-mangling
 * bundlers).
 */

export class __Entity__Error extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "__Entity__Error";
  }
}

export class __Entity__NotFoundError extends __Entity__Error {
  override readonly name = "__Entity__NotFoundError";
  constructor(public readonly id: string) {
    super(`__Entity__ "${id}" not found`);
  }
}

export class Invalid__Entity__IdError extends __Entity__Error {
  override readonly name = "Invalid__Entity__IdError";
  constructor(public readonly id: string) {
    super(`Invalid __entity__ id: "${id}"`);
  }
}
