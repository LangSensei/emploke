/**
 * Unit tests for `makeScheduleAgentValidator`. Verifies the adapter
 * collapses `CatalogService.getAgent(fqn): Promise<Agent | null>`
 * into the `(fqn) => Promise<void>` throws-on-invalid validator
 * shape that `@emploke/schedule` expects.
 */

import type { CatalogService } from "@emploke/catalog";
import { AgentNotFoundError } from "@emploke/schedule";
import { describe, expect, it, vi } from "vitest";
import { makeScheduleAgentValidator } from "../../src/wiring/schedule-agent-validator.js";

function stubCatalog(found: unknown | null): {
  getAgent: ReturnType<typeof vi.fn>;
  service: CatalogService;
} {
  const getAgent = vi.fn(async (_fqn: string) => found);
  const service = { getAgent } as unknown as CatalogService;
  return { getAgent, service };
}

describe("makeScheduleAgentValidator", () => {
  it("resolves without throwing when catalog returns a non-null Agent", async () => {
    const { getAgent, service } = stubCatalog({ name: "writer" });
    const validate = makeScheduleAgentValidator(service);
    await expect(validate("writer")).resolves.toBeUndefined();
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(getAgent).toHaveBeenCalledWith("writer");
  });

  it("throws `@emploke/schedule`'s AgentNotFoundError when catalog returns null", async () => {
    // The typed-marker contract: `ScheduleService.assertAgentExists`
    // uses `instanceof` against this exact class to distinguish
    // 'agent missing' (400) from 'catalog system fault' (500).
    // A plain `Error` here would re-introduce the catch-wrap bug
    // that the G2b PR was written to fix.
    const { service } = stubCatalog(null);
    const validate = makeScheduleAgentValidator(service);
    await expect(validate("ghost")).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("error message includes the FQN (useful for cause-chain inspection)", async () => {
    const { service } = stubCatalog(null);
    const validate = makeScheduleAgentValidator(service);
    let captured: unknown;
    try {
      await validate("acme/ghost-agent");
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(AgentNotFoundError);
    expect((captured as AgentNotFoundError).agent).toBe("acme/ghost-agent");
    expect((captured as Error).message).toContain("acme/ghost-agent");
  });

  it("calls catalog.getAgent exactly once with the exact fqn argument", async () => {
    const { getAgent, service } = stubCatalog({ name: "x" });
    const validate = makeScheduleAgentValidator(service);
    await validate("scope/name");
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(getAgent).toHaveBeenCalledWith("scope/name");
  });
});
