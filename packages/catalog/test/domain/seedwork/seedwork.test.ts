import type { NotificationData } from "mediatr-ts";
import { describe, expect, it } from "vitest";
import { Entity } from "../../../src/domain/seedwork/entity.js";
import { ValueObject } from "../../../src/domain/seedwork/value-object.js";

class Foo extends Entity {
  override id: string;
  constructor(id: string) {
    super();
    this.id = id;
  }
  raise(event: NotificationData): void {
    this.addDomainEvent(event);
  }
  drop(event: NotificationData): void {
    this.removeDomainEvent(event);
  }
}

class Bar extends Entity {
  override id: string;
  constructor(id: string) {
    super();
    this.id = id;
  }
}

class Pair extends ValueObject {
  constructor(
    readonly a: string,
    readonly b: number,
  ) {
    super();
  }
  protected override equalityComponents(): readonly unknown[] {
    return [this.a, this.b];
  }
}

class NestedPair extends ValueObject {
  constructor(readonly inner: Pair) {
    super();
  }
  protected override equalityComponents(): readonly unknown[] {
    return [this.inner];
  }
}

describe("Entity (catalog seedwork)", () => {
  it("equals is true for same concrete type + same id", () => {
    const a = new Foo("x");
    const b = new Foo("x");
    expect(a.equals(b)).toBe(true);
  });

  it("equals is false across concrete types even with same id", () => {
    expect(new Foo("x").equals(new Bar("x"))).toBe(false);
  });

  it("equals is false for same type but different ids", () => {
    expect(new Foo("x").equals(new Foo("y"))).toBe(false);
  });

  it("buffers, pulls and clears domain events", () => {
    const f = new Foo("x");
    const e1 = {} as NotificationData;
    const e2 = {} as NotificationData;
    f.raise(e1);
    f.raise(e2);
    const pulled = f.pullDomainEvents();
    expect(pulled).toEqual([e1, e2]);
    // pullDomainEvents takes ownership: a second pull yields an empty buffer
    expect(f.pullDomainEvents()).toEqual([]);
  });

  it("clearDomainEvents drops the buffer without dispatching", () => {
    const f = new Foo("x");
    const e1 = {} as NotificationData;
    f.raise(e1);
    f.clearDomainEvents();
    expect(f.pullDomainEvents()).toEqual([]);
  });

  it("removeDomainEvent drops a single specific event", () => {
    const f = new Foo("x");
    const e1 = {} as NotificationData;
    const e2 = {} as NotificationData;
    f.raise(e1);
    f.raise(e2);
    f.drop(e1);
    expect(f.pullDomainEvents()).toEqual([e2]);
  });
});

describe("ValueObject (catalog seedwork)", () => {
  it("equals is true for same concrete type + same components", () => {
    expect(new Pair("a", 1).equals(new Pair("a", 1))).toBe(true);
  });

  it("equals is false on a single differing component", () => {
    expect(new Pair("a", 1).equals(new Pair("a", 2))).toBe(false);
  });

  it("compares nested VO components via their own equals (not ===)", () => {
    const a = new NestedPair(new Pair("a", 1));
    const b = new NestedPair(new Pair("a", 1));
    expect(a.equals(b)).toBe(true);
  });

  it("returns false on non-VO operand", () => {
    expect(new Pair("a", 1).equals({ a: "a", b: 1 })).toBe(false);
    expect(new Pair("a", 1).equals(null)).toBe(false);
  });
});
