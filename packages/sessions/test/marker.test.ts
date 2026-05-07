import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markerPathFor, readMarker, writeMarker } from "../src/marker.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "emploke-sessions-marker-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("marker", () => {
  it("writes and reads a valid marker", async () => {
    await writeMarker(workdir, {
      version: 1,
      agent: "demo",
      catalogDir: "/abs/catalog",
      createdAt: "2026-05-08T01:05:00.000Z",
    });
    const m = await readMarker(workdir);
    expect(m).toEqual({
      version: 1,
      agent: "demo",
      catalogDir: "/abs/catalog",
      createdAt: "2026-05-08T01:05:00.000Z",
    });
  });

  it("does not include id field", async () => {
    await writeMarker(workdir, {
      version: 1,
      agent: "demo",
      createdAt: "2026-05-08T01:05:00.000Z",
    });
    const raw = await readFile(markerPathFor(workdir), "utf8");
    const obj = JSON.parse(raw);
    expect(obj).not.toHaveProperty("id");
  });

  it("returns null for missing marker", async () => {
    const m = await readMarker(workdir);
    expect(m).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    await mkdir(path.join(workdir, ".emploke"), { recursive: true });
    await writeFile(markerPathFor(workdir), "{not json", "utf8");
    expect(await readMarker(workdir)).toBeNull();
  });

  it.each([
    { version: 2, agent: "x", createdAt: "2026-05-08T01:05:00.000Z" },
    { version: 1, agent: "", createdAt: "2026-05-08T01:05:00.000Z" },
    { version: 1, agent: "x", createdAt: "not-a-date" },
    { version: 1, createdAt: "2026-05-08T01:05:00.000Z" },
    null,
    [],
    "string",
  ])("returns null for invalid marker %#", async (body) => {
    await mkdir(path.join(workdir, ".emploke"), { recursive: true });
    await writeFile(markerPathFor(workdir), JSON.stringify(body), "utf8");
    expect(await readMarker(workdir)).toBeNull();
  });

  it("write is atomic (no .tmp left behind)", async () => {
    await writeMarker(workdir, {
      version: 1,
      agent: "demo",
      createdAt: "2026-05-08T01:05:00.000Z",
    });
    const tmp = `${markerPathFor(workdir)}.tmp`;
    await expect(readFile(tmp, "utf8")).rejects.toThrow();
  });
});
