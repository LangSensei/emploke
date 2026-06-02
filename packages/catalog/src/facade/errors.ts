/**
 * Cross-entity catalog errors. Errors that originate inside a single
 * entity service (skill / agent / mcp) propagate as-is; this file
 * re-exports the dep-protection error from `_shared/` so existing
 * facade-internal imports (`./errors.js`) keep working.
 *
 * `HasDependentsError` itself lives in `_shared/dependents-error.ts`
 * because the per-entity repositories (which sit below the facade
 * layer) raise it directly from inside their delete transactions.
 */

export { HasDependentsError } from "../_shared/dependents-error.js";
