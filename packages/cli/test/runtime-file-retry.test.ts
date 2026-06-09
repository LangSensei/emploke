import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import writeFileAtomic from "write-file-atomic";
import { type RuntimeFile, writeRuntimeFile } from "../src/runtime-file.js";

// Deterministic coverage for the bounded-retry wrapper around
// `write-file-atomic`. We mock the library so the test does not depend
// on real fs timing (or on Windows-vs-POSIX rename behaviour). The
// "concurrent reads see a complete payload" test in `runtime-file.test.ts`
// still pins the contract end-to-end on POSIX; this file pins the
// retry decision tree.
vi.mock("write-file-atomic", () => ({ default: vi.fn() }));

const mockedWriteFileAtomic = vi.mocked(writeFileAtomic);

let home: string;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "emploke-cli-rf-retry-"));
  mockedWriteFileAtomic.mockReset();
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  debugSpy.mockRestore();
});

const payload: RuntimeFile = {
  schema: 1,
  pid: 4242,
  host: "127.0.0.1",
  port: 8787,
  startedAt: "2026-06-09T00:00:00.000Z",
  serverArgs: [],
};

const errnoErr = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

describe("writeRuntimeFile retry behaviour", () => {
  it("retries on EPERM and eventually succeeds, emitting a debug log", async () => {
    mockedWriteFileAtomic
      .mockRejectedValueOnce(errnoErr("EPERM"))
      .mockRejectedValueOnce(errnoErr("EPERM"))
      .mockResolvedValueOnce(undefined);

    await writeRuntimeFile(home, payload);

    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(3);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const msg = String(debugSpy.mock.calls[0]?.[0]);
    expect(msg).toMatch(/retried-write/);
    expect(msg).toMatch(/attempts=3/);
  });

  it("retries on EBUSY", async () => {
    mockedWriteFileAtomic.mockRejectedValueOnce(errnoErr("EBUSY")).mockResolvedValueOnce(undefined);

    await writeRuntimeFile(home, payload);

    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(2);
  });

  it("retries on EACCES", async () => {
    mockedWriteFileAtomic
      .mockRejectedValueOnce(errnoErr("EACCES"))
      .mockResolvedValueOnce(undefined);

    await writeRuntimeFile(home, payload);

    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on a non-retryable errno (e.g. ENOSPC)", async () => {
    mockedWriteFileAtomic.mockRejectedValueOnce(errnoErr("ENOSPC"));

    await expect(writeRuntimeFile(home, payload)).rejects.toMatchObject({
      code: "ENOSPC",
    });
    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("gives up after the bounded retry budget (8 attempts) when EPERM persists, emitting a give-up log", async () => {
    mockedWriteFileAtomic.mockRejectedValue(errnoErr("EPERM"));

    await expect(writeRuntimeFile(home, payload)).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(8);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const msg = String(debugSpy.mock.calls[0]?.[0]);
    expect(msg).toMatch(/giving-up/);
    expect(msg).toMatch(/attempts=8/);
    expect(msg).toMatch(/code=EPERM/);
  });

  it("does not log on a first-try success (zero-overhead happy path)", async () => {
    mockedWriteFileAtomic.mockResolvedValueOnce(undefined);

    await writeRuntimeFile(home, payload);

    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
