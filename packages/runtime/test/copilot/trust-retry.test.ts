import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import writeFileAtomic from "write-file-atomic";
import { TrustRegistrationFailed } from "../../src/copilot/errors.js";
import { ensureDirTrusted } from "../../src/copilot/trust.js";

// Deterministic coverage for the bounded-retry wrapper around
// `write-file-atomic` in `copilot/trust.ts`. The concurrent
// "serialises concurrent calls" test in `trust.test.ts` still
// pins the lock + write contract end-to-end on POSIX; this file
// pins the retry decision tree without needing Windows or real
// rename contention.
vi.mock("write-file-atomic", () => ({ default: vi.fn() }));

const mockedWriteFileAtomic = vi.mocked(writeFileAtomic);

// Mock-success implementation: actually write the file so the rest
// of `ensureDirTrusted` (which then takes a lockfile and re-reads
// the file) can proceed. We only want to control _whether_ the
// atomic write fails, not strip out its side effect.
const realWrite = async (p: unknown, body: unknown): Promise<void> => {
  await writeFile(p as string, body as string);
};

let scratch: string;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "rt-copilot-trust-retry-"));
  mockedWriteFileAtomic.mockReset();
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  debugSpy.mockRestore();
});

const errnoErr = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

describe("ensureDirTrusted retry behaviour", () => {
  it("retries on EPERM during the missing-file touch and eventually succeeds", async () => {
    // configPath is absent → `ensureDirTrusted` hits the
    // touch-empty-config branch first, which is one of the
    // wrap sites we care about. We inject EPERM on the first
    // call and then defer to a real write so the rest of the
    // orchestration (lockfile + final write) can proceed.
    const dir = path.join(scratch, "workspace");
    await mkdir(dir, { recursive: true });
    const configPath = path.join(scratch, "copilot-config.json");

    mockedWriteFileAtomic
      .mockRejectedValueOnce(errnoErr("EPERM"))
      .mockImplementationOnce(realWrite) // touch "{}" succeeds on attempt 2
      .mockImplementationOnce(realWrite); // final config write

    await ensureDirTrusted(dir, configPath);

    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(3);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const msg = String(debugSpy.mock.calls[0]?.[0]);
    expect(msg).toMatch(/retried-write/);
    expect(msg).toMatch(/attempts=2/);
  });

  it("retries on EBUSY at the final config-write site and emits a debug log", async () => {
    // Pre-create the config file so we skip the touch site and hit
    // the second wrap site (line 156) directly.
    const dir = path.join(scratch, "workspace");
    await mkdir(dir, { recursive: true });
    const configPath = path.join(scratch, "copilot-config.json");
    await writeFile(configPath, "{}");

    mockedWriteFileAtomic
      .mockRejectedValueOnce(errnoErr("EBUSY"))
      .mockImplementationOnce(realWrite);

    await ensureDirTrusted(dir, configPath);

    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(2);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0]?.[0])).toMatch(/retried-write/);
  });

  it("propagates persistent EPERM as TrustRegistrationFailed after the bounded budget, emitting a give-up log", async () => {
    const dir = path.join(scratch, "workspace");
    await mkdir(dir, { recursive: true });
    const configPath = path.join(scratch, "copilot-config.json");
    mockedWriteFileAtomic.mockRejectedValue(errnoErr("EPERM"));

    const err = await ensureDirTrusted(dir, configPath).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TrustRegistrationFailed);
    // 8 attempts on the first call site (touch). It never reaches
    // the second call site because the touch failure bubbles up.
    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(8);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const msg = String(debugSpy.mock.calls[0]?.[0]);
    expect(msg).toMatch(/giving-up/);
    expect(msg).toMatch(/attempts=8/);
    expect(msg).toMatch(/code=EPERM/);
  });

  it("does NOT retry on a non-retryable errno (e.g. ENOSPC)", async () => {
    const dir = path.join(scratch, "workspace");
    await mkdir(dir, { recursive: true });
    const configPath = path.join(scratch, "copilot-config.json");
    mockedWriteFileAtomic.mockRejectedValueOnce(errnoErr("ENOSPC"));

    const err = await ensureDirTrusted(dir, configPath).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TrustRegistrationFailed);
    expect(mockedWriteFileAtomic).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
