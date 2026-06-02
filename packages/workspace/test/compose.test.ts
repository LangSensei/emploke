import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeWorkspaceModule } from "../src/index.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-compose-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("composeWorkspaceModule", () => {
  it("opens a fresh in-memory DB and serves an empty registry", async () => {
    const mod = await composeWorkspaceModule({ dbFile: ":memory:" });
    try {
      expect(await mod.service.list()).toEqual([]);
      await mod.service.register({
        id: "11111111-1111-4111-8111-111111111111",
        workspaceDir: path.join(scratch, "p"),
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
