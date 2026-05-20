import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Mediator } from "mediatr-ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServerContainer } from "../src/bootstrap.js";
import {
  type ServerTestSubsystem,
  setupTestSubsystem,
  teardownTestSubsystem,
} from "./_test-support.js";

let scratch: string;
let sys: ServerTestSubsystem;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-bootstrap-"));
  sys = await setupTestSubsystem({ scratch });
});

afterEach(async () => {
  await teardownTestSubsystem(sys);
  await rm(scratch, { recursive: true, force: true });
});

describe("inversify bootstrap (Phase 2 of #135 / ADR-3)", () => {
  it("constructs a container with the mediator wired", () => {
    const mediator = sys.container.get(Mediator);
    expect(mediator).toBeInstanceOf(Mediator);
  });

  it("re-running buildServerContainer with a fresh ORM is safe (no global-state collisions)", async () => {
    const sys2 = await setupTestSubsystem({ scratch });
    try {
      await expect(buildServerContainer({ workspace: { orm: sys2.orm } })).resolves.toBeDefined();
    } finally {
      await teardownTestSubsystem(sys2);
    }
  });

  it("returns a fresh container per call (no hidden process-wide singleton)", async () => {
    const sys2 = await setupTestSubsystem({ scratch });
    try {
      expect(sys.container).not.toBe(sys2.container);
      expect(sys.container.get(Mediator)).not.toBe(sys2.container.get(Mediator));
    } finally {
      await teardownTestSubsystem(sys2);
    }
  });
});
