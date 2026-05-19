/**
 * Regression test for the env-merge contract on the SDK-backed
 * headless launcher.
 *
 * The SDK's `CopilotClient({ env })` REPLACES `process.env` for the
 * spawned CLI subprocess rather than merging. If `launchCopilotHeadless`
 * forwarded `opts.subprocessEnv` as-is, the subprocess would see ONLY
 * emploke's own EMPLOKE_* additions and lose every system env var
 * (`PATH`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, …),
 * which breaks every downstream tool that needs them (`gh` can't reach
 * the Windows Credential Manager without USERPROFILE; `node`/`pnpm`
 * stop resolving against the user's installed toolchain without PATH).
 *
 * `launchCopilotHeadless` therefore merges `subprocessEnv` on top of
 * `process.env` and honours `undefined` overrides as "delete this key
 * from the parent env" (used by `buildSubprocessEnvBase` to scrub
 * EMPLOKE_HOME from every task subprocess).
 *
 * This test pins both halves of the contract by stubbing the SDK client
 * to capture the `env` it would have been constructed with, then
 * deliberately throwing from `client.start()` so we don't have to mock
 * the full session lifecycle.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import type { CopilotClient } from "@github/copilot-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchCopilotHeadless } from "../../src/copilot/launch-headless.js";
import { RuntimeHeadlessLaunchFailed } from "../../src/errors.js";
import { makeTestCatalog } from "./test-catalog.js";

const FRAMING = "do the thing";

let scratch: string;
let workdir: string;
let stateDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "rt-env-merge-"));
  workdir = path.join(scratch, "work");
  stateDir = path.join(scratch, "copilot-state");
  await mkdir(workdir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function buildAgent(): Promise<{ agent: AgentResolveResult; catalog: CatalogManager }> {
  const agentBody = "---\nname: demo\ndescription: d\nversion: 0.0.1\n---\n# demo\n";
  const { catalog } = await makeTestCatalog({
    agents: { demo: { "AGENTS.md": agentBody } },
  });
  return { agent: await catalog.resolveAgent("public/demo"), catalog };
}

/**
 * Build a fake CopilotClient that captures the constructor options
 * (so we can assert on `env`) and then throws from `start()` to abort
 * the launch before any real CLI work happens.
 */
function capturingClientFactory(): {
  capture: { env?: NodeJS.ProcessEnv };
  factory: (options: ConstructorParameters<typeof CopilotClient>[0]) => CopilotClient;
} {
  const capture: { env?: NodeJS.ProcessEnv } = {};
  const factory = (options: ConstructorParameters<typeof CopilotClient>[0]): CopilotClient => {
    capture.env = options?.env as NodeJS.ProcessEnv | undefined;
    // Minimal CopilotClient stub. We only need `start` to throw so the
    // launch flow exits via the documented RuntimeHeadlessLaunchFailed
    // path; nothing else is called after start() rejects.
    return {
      start: () => Promise.reject(new Error("STUB_NO_START")),
      stop: () => Promise.resolve(),
      createSession: () => Promise.reject(new Error("should not be reached")),
    } as unknown as CopilotClient;
  };
  return { capture, factory };
}

describe("launchCopilotHeadless env merge", () => {
  it("merges subprocessEnv on top of process.env", async () => {
    const { agent, catalog } = await buildAgent();
    const { capture, factory } = capturingClientFactory();

    await expect(
      launchCopilotHeadless(
        {
          taskDir: workdir,
          agent,
          catalog,
          prompt: FRAMING,
          workspaceDir: scratch,
          subprocessEnv: {
            EMPLOKE_WORKSPACE: "ws-fixture-123",
            EMPLOKE_WORK_ID: "task-fixture-456",
          },
        },
        {
          copilotStateDir: stateDir,
          sharedDir: path.join(scratch, "shared"),
          createClient: factory,
          registerSession: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(RuntimeHeadlessLaunchFailed);

    expect(capture.env).toBeDefined();
    const env = capture.env as NodeJS.ProcessEnv;

    // The overrides MUST be present verbatim.
    expect(env.EMPLOKE_WORKSPACE).toBe("ws-fixture-123");
    expect(env.EMPLOKE_WORK_ID).toBe("task-fixture-456");

    // Parent env must survive — pick a key that ALWAYS exists on every
    // host the test suite runs on. PATH is universal; PWD/HOME/USERPROFILE
    // are platform-specific. Any of these being absent would mean the
    // subprocess inherited an empty env, which is exactly the regression
    // this test is here to catch.
    expect(env.PATH ?? env.Path ?? env.path).toBeDefined();
  });

  it("honours undefined overrides as 'delete the key from parent env'", async () => {
    const { agent, catalog } = await buildAgent();

    // Seed a real env var in the parent process so we can assert it
    // gets stripped by the override.
    const sentinelKey = "EMPLOKE_TEST_SENTINEL_TO_DELETE";
    process.env[sentinelKey] = "should-be-stripped";
    try {
      const { capture, factory } = capturingClientFactory();

      await expect(
        launchCopilotHeadless(
          {
            taskDir: workdir,
            agent,
            catalog,
            prompt: FRAMING,
            workspaceDir: scratch,
            subprocessEnv: {
              [sentinelKey]: undefined,
            },
          },
          {
            copilotStateDir: stateDir,
            sharedDir: path.join(scratch, "shared"),
            createClient: factory,
            registerSession: () => {},
          },
        ),
      ).rejects.toBeInstanceOf(RuntimeHeadlessLaunchFailed);

      const env = capture.env as NodeJS.ProcessEnv;
      // Sentinel key was in process.env when we made the call. The
      // override mapped it to `undefined`, which MUST be interpreted as
      // "delete it from the merged env" rather than passed through to
      // the SDK as the string "undefined".
      expect(env).toBeDefined();
      expect(sentinelKey in env).toBe(false);
    } finally {
      delete process.env[sentinelKey];
    }
  });

  it("passes the parent env through unchanged when no subprocessEnv is supplied", async () => {
    const { agent, catalog } = await buildAgent();
    const { capture, factory } = capturingClientFactory();

    await expect(
      launchCopilotHeadless(
        {
          taskDir: workdir,
          agent,
          catalog,
          prompt: FRAMING,
          workspaceDir: scratch,
        },
        {
          copilotStateDir: stateDir,
          sharedDir: path.join(scratch, "shared"),
          createClient: factory,
          registerSession: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(RuntimeHeadlessLaunchFailed);

    expect(capture.env).toBeDefined();
    const env = capture.env as NodeJS.ProcessEnv;
    expect(env.PATH ?? env.Path ?? env.path).toBeDefined();
    // It IS a copy (not the same reference) so the caller can't
    // accidentally mutate process.env via the SDK.
    expect(env).not.toBe(process.env);
  });
});
