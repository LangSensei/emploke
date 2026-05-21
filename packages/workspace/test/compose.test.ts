import { describe, expect, it } from "vitest";
import { composeWorkspaceModule } from "../src/index.js";
import { openTestWorkspaceOrm } from "../src/testing.js";

describe("composeWorkspaceModule", () => {
  it("returns a service + queries pair backed by the given ORM", async () => {
    const orm = await openTestWorkspaceOrm();
    const mod = await composeWorkspaceModule({ orm });
    try {
      expect(await mod.queries.list()).toEqual([]);
      await mod.service.register({
        id: "11111111-1111-4111-8111-111111111111",
        workspaceDir: "/tmp/emploke-compose-test",
        name: "Compose",
      });
      const view = await mod.queries.getById("11111111-1111-4111-8111-111111111111");
      expect(view?.name).toBe("Compose");
    } finally {
      await mod.close();
      await orm.close(true);
    }
  });

  it("compose({ orm }) close is a no-op (caller owns ORM lifecycle)", async () => {
    const orm = await openTestWorkspaceOrm();
    const mod = await composeWorkspaceModule({ orm });
    await mod.close();
    // ORM still usable after module close because the module didn't own it.
    expect(await orm.em.fork().count(await import("../src/entity.js").then((m) => m.Workspace))).toBe(
      0,
    );
    await orm.close(true);
  });
});
