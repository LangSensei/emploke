import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __Entity__Repository } from "../src/__entity-kebab__-repository.js";
import { __Entity__Service } from "../src/__entity-kebab__-service.js";
import { __Entity__NotFoundError } from "../src/errors.js";
import { openTest__Entity__Db } from "../src/testing.js";

let handle: ReturnType<typeof openTest__Entity__Db>;
let repo: __Entity__Repository;
let service: __Entity__Service;

beforeEach(() => {
  handle = openTest__Entity__Db();
  repo = new __Entity__Repository({ db: handle.db });
  service = new __Entity__Service(repo);
});

afterEach(() => {
  handle.close();
});

describe("__Entity__Service", () => {
  it("create then get round-trips name and createdAt", async () => {
    const created = await service.create({ name: "first" });
    const fetched = await service.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("first");
    expect(fetched?.createdAt).toBe(created.createdAt);
  });

  it("list returns all rows by default and filters by nameStartsWith", async () => {
    await service.create({ name: "apple" });
    await service.create({ name: "apricot" });
    await service.create({ name: "banana" });
    expect((await service.list()).length).toBe(3);
    const ap = await service.list({ nameStartsWith: "ap" });
    expect(ap.map((e) => e.name).sort()).toEqual(["apple", "apricot"]);
  });

  it("delete on a non-existent id throws __Entity__NotFoundError", async () => {
    await expect(service.delete("missing")).rejects.toBeInstanceOf(__Entity__NotFoundError);
  });

  it("get on a non-existent id returns null (not throws)", async () => {
    expect(await service.get("missing")).toBeNull();
  });
});
