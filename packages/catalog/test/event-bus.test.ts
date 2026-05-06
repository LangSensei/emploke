import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../src/event-bus.js";

describe("InMemoryEventBus", () => {
  it("delivers events to all subscribed handlers in subscription order", () => {
    const bus = new InMemoryEventBus<number>();
    const log: string[] = [];
    bus.subscribe((n) => log.push(`a:${n}`));
    bus.subscribe((n) => log.push(`b:${n}`));
    bus.publish(1);
    bus.publish(2);
    expect(log).toEqual(["a:1", "b:1", "a:2", "b:2"]);
  });

  it("unsubscribe stops further deliveries", () => {
    const bus = new InMemoryEventBus<number>();
    const log: number[] = [];
    const unsub = bus.subscribe((n) => log.push(n));
    bus.publish(1);
    unsub();
    bus.publish(2);
    expect(log).toEqual([1]);
  });

  it("isolates throwing handler from later handlers", () => {
    const bus = new InMemoryEventBus<number>();
    const log: number[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((n) => log.push(n));
    expect(() => bus.publish(42)).not.toThrow();
    expect(log).toEqual([42]);
  });

  it("subscribe returns idempotent unsubscribe", () => {
    const bus = new InMemoryEventBus<number>();
    const log: number[] = [];
    const unsub = bus.subscribe((n) => log.push(n));
    unsub();
    unsub(); // calling twice must not throw
    bus.publish(1);
    expect(log).toEqual([]);
  });
});
