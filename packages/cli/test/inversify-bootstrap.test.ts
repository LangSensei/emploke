import "reflect-metadata";
import { Mediator } from "mediatr-ts";
import { describe, expect, it } from "vitest";
import { buildCliContainer } from "../src/bootstrap.js";

describe("inversify bootstrap (Phase 0 foundation of #135)", () => {
  it("constructs a container with the mediator wired", () => {
    const container = buildCliContainer();
    const mediator = container.get(Mediator);
    expect(mediator).toBeInstanceOf(Mediator);
  });

  it("calls every package's composeXxxModule without throwing", () => {
    expect(() => buildCliContainer()).not.toThrow();
  });

  it("returns a fresh container per call (one container per CLI invocation)", () => {
    const a = buildCliContainer();
    const b = buildCliContainer();
    expect(a).not.toBe(b);
    expect(a.get(Mediator)).not.toBe(b.get(Mediator));
  });
});
