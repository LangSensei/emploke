import { describe, expect, it } from "vitest";
import { composeWorkspaceModule } from "../src/index.js";

describe("composeWorkspaceModule", () => {
  it("opens a fresh in-memory DB and serves an empty registry", async () => {
    const mod = await composeWorkspaceModule({ dbFile: ":memory:" });
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
    }
  });

  it("close releases the underlying sqlite connection", async () => {
    const mod = await composeWorkspaceModule({ dbFile: ":memory:" });
    await mod.close();
    // After close, the service must not be usable (sqlite handle is closed).
    await expect(mod.service.list()).rejects.toThrow();
  });
});
