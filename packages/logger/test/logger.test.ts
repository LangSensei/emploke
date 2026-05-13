import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLogger, silentLogger } from "../src/index.js";

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-logger-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Wait for pino's worker thread to flush. Pino uses an async transport
 * so writes are not visible immediately — we poll with a short backoff
 * rather than baking in a fixed sleep.
 */
async function waitForLogFile(dir: string, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const log = entries.find((e) => e.startsWith("server"));
    if (log) {
      // Confirm at least one byte landed before we declare success.
      const content = await readFile(path.join(dir, log), "utf8");
      if (content.length > 0) return path.join(dir, log);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no log file appeared under ${dir} within ${timeoutMs}ms`);
}

describe("silentLogger", () => {
  it("drops every call without throwing or logging", () => {
    silentLogger.debug("dbg");
    silentLogger.info({ k: 1 }, "info");
    silentLogger.warn({ k: 2 }, "warn");
    silentLogger.error({ k: 3 }, "err");
    // The point is just that none of these threw and there's no fs
    // side-effect to clean up.
    expect(true).toBe(true);
  });
});

describe("buildLogger — file destination", () => {
  it("writes JSON lines to a daily-rotated file under `dir`", async () => {
    const logger = buildLogger({ dir: scratch, level: "debug", basename: "server" });
    logger.info({ user: "alice", n: 1 }, "hello");
    logger.warn({ code: "E_TEST" }, "oops");

    const file = await waitForLogFile(scratch);
    const lines = (await readFile(file, "utf8")).trim().split("\n");

    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(lines[0]);
    expect(first.msg).toBe("hello");
    expect(first.user).toBe("alice");
    expect(first.n).toBe(1);
    expect(first.level).toBe(30); // pino numeric for "info"

    const second = JSON.parse(lines[1]);
    expect(second.msg).toBe("oops");
    expect(second.code).toBe("E_TEST");
    expect(second.level).toBe(40); // pino numeric for "warn"
  });

  it("respects `level` — sub-threshold calls do not appear", async () => {
    const logger = buildLogger({ dir: scratch, level: "warn", basename: "server" });
    logger.debug("debug-dropped");
    logger.info("info-dropped");
    logger.warn("warn-kept");
    logger.error("error-kept");

    const file = await waitForLogFile(scratch);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const messages = lines.map((l) => JSON.parse(l).msg);
    expect(messages).toContain("warn-kept");
    expect(messages).toContain("error-kept");
    expect(messages).not.toContain("debug-dropped");
    expect(messages).not.toContain("info-dropped");
  });

  it("creates `dir` on demand if missing", async () => {
    const nested = path.join(scratch, "a", "b", "c");
    const logger = buildLogger({ dir: nested, level: "info" });
    logger.info("nested");
    const file = await waitForLogFile(nested);
    expect(file.startsWith(nested)).toBe(true);
  });
});
