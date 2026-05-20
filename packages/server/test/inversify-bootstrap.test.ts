import "reflect-metadata";
import { Mediator } from "mediatr-ts";
import { describe, expect, it } from "vitest";
import { buildServerContainer } from "../src/bootstrap.js";

describe("inversify bootstrap (Phase 0 foundation of #135)", () => {
  it("constructs a container with the mediator wired", () => {
    const container = buildServerContainer();
    const mediator = container.get(Mediator);
    expect(mediator).toBeInstanceOf(Mediator);
  });

  it("calls every package's composeXxxModule without throwing", () => {
    expect(() => buildServerContainer()).not.toThrow();
  });

  it("returns a fresh container per call (no hidden process-wide singleton)", () => {
    const a = buildServerContainer();
    const b = buildServerContainer();
    expect(a).not.toBe(b);
    expect(a.get(Mediator)).not.toBe(b.get(Mediator));
  });
});
