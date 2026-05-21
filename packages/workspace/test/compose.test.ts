import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { composeWorkspaceModule } from "../src/index.js";
import { workspaces } from "../src/schema.js";
import { openTestWorkspaceDb } from "../src/testing.js";

describe("composeWorkspaceModule", () => {
  it("returns a service + queries pair backed by the given db", async () => {
    const handle = openTestWorkspaceDb();
    const mod = await composeWorkspaceModule({ db: handle.db });
    try {
      expect(await mod.service.list()).toEqual([]);
      await mod.service.register({
        id: "11111111-1111-4111-8111-111111111111",
        workspaceDir: "/tmp/emploke-compose-test",
        name: "Compose",
      });
      const view = await mod.service.getById("11111111-1111-4111-8111-111111111111");
      expect(view?.name).toBe("Compose");
    } finally {
      await mod.close();
      handle.close();
    }
  });

  it("compose({ db }) close is a no-op (caller owns connection lifecycle)", async () => {
    const handle = openTestWorkspaceDb();
    const mod = await composeWorkspaceModule({ db: handle.db });
    await mod.close();
    // Connection still usable after module close because the module didn't own it.
    const row = handle.db.select({ value: count() }).from(workspaces).get();
    expect(row?.value).toBe(0);
    handle.close();
  });
});
