/**
 * Coerces an unknown thrown value (the type narrowed in a `catch`) into
 * a user-displayable string. Use in place of `(e as Error).message` at
 * dashboard catch sites; `e` is `unknown` after TS 4.4's catch-clause
 * change and the cast is both unsafe and noisy.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/**
 * True when the value is the canonical `AbortError` raised by
 * `AbortController` / `fetch(..., { signal })`. Use to filter the
 * expected-reject path so abort doesn't surface as a real error in
 * the UI (e.g. the user navigated away mid-fetch).
 */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
