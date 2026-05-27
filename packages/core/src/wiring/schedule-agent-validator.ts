import type { CatalogService } from "@emploke/catalog";

/**
 * Bridge the catalog's nullable `getAgent` lookup into the
 * throws-on-invalid validator shape that `@emploke/schedule` expects.
 *
 * On null → throws a plain `Error` with a stable, audit-able message.
 * `ScheduleService.assertAgentExists` rewraps it in its typed
 * `AgentNotFoundError` (with `cause`), so the message we throw here
 * is opaque to end-users — it shows up only in logs / cause-chain
 * inspection, never in the API error body.
 */
export function makeScheduleAgentValidator(
  catalog: CatalogService,
): (fqn: string) => Promise<void> {
  return async (fqn) => {
    const agent = await catalog.getAgent(fqn);
    if (agent === null) {
      throw new Error(`agent "${fqn}" is not in this workspace's catalog`);
    }
  };
}
