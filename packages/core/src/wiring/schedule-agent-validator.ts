import type { CatalogService } from "@emploke/catalog";
import { AgentNotFoundError } from "@emploke/schedule";

/**
 * Bridge the catalog's nullable `getAgent` lookup into the
 * throws-on-invalid validator shape that `@emploke/schedule` expects.
 *
 * On null → throws `@emploke/schedule`'s `AgentNotFoundError(fqn)`.
 * `ScheduleService.assertAgentExists` recognises this via `instanceof`
 * and re-throws it untouched; any OTHER error from `catalog.getAgent`
 * is treated as a catalog-system fault and wrapped as
 * `AgentResolutionFailedError → 500`.
 *
 * The typed marker replaces the previous bare `Error` throw — its
 * `.message` (`Agent "X" not found`) is user-facing and is
 * allow-listed via `SAFE_ERROR_NAMES` so the wire envelope surfaces
 * the agent FQN intact.
 */
export function makeScheduleAgentValidator(
  catalog: CatalogService,
): (fqn: string) => Promise<void> {
  return async (fqn) => {
    const agent = await catalog.getAgent(fqn);
    if (agent === null) {
      throw new AgentNotFoundError(fqn);
    }
  };
}
