import { injectable } from "inversify";
import { Clock } from "../domain/clock.js";

/**
 * Production {@link Clock} implementation: `new Date().toISOString()`.
 *
 * Bound in `composeWorkspaceModule` as a singleton — there is no
 * per-call state and the result is cheap, so a shared instance is
 * fine. Tests substitute a fixed-time clock by rebinding `Clock`
 * directly on the container or by passing a custom implementation
 * into handler constructors.
 */
@injectable()
export class SystemClock extends Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}
