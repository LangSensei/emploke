/**
 * Unit tests for the typed `ApiClient`. Mock-fetch based — no real
 * server is involved. Asserts:
 *  - URL building (path + params + query)
 *  - method / headers / body wiring
 *  - 204 short-circuit returns undefined
 *  - 4xx / 5xx throw {@link ApiError} with the parsed body attached
 *  - calls without an opts argument compile + work for routes that
 *    declare no body / params (regression guard against a future
 *    `HasRequired` regression)
 */

import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../src/api-client.js";

interface MockResponse {
  status: number;
  contentType?: string;
  body?: string;
}

interface CallRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeClient(responses: MockResponse[]): {
  client: ApiClient;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let i = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    const body = init?.body === undefined ? undefined : String(init.body);
    calls.push({ url, method, headers, body });
    const r = responses[i++] ?? { status: 200, contentType: "application/json", body: "{}" };
    return new Response(r.body, {
      status: r.status,
      headers: r.contentType ? { "content-type": r.contentType } : {},
    });
  };
  const client = new ApiClient({ baseUrl: "http://test.local", apiKey: "secret", fetch: fetchFn });
  return { client, calls };
}

describe("ApiClient", () => {
  it("GET with no opts hits /api/health", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ok",
          name: "x",
          version: "1",
          startedAt: "t",
          uptimeSec: 1,
          serverNow: "t",
        }),
      },
    ]);
    const result = await client.call("health.get");
    expect(result.status).toBe("ok");
    expect(calls[0]?.url).toBe("http://test.local/api/health");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.Authorization).toBe("Bearer secret");
    expect(calls[0]?.body).toBeUndefined();
  });

  it("substitutes :id placeholders from params", async () => {
    const { client, calls } = makeClient([
      { status: 200, contentType: "application/json", body: "[]" },
    ]);
    await client.call("sessions.list", {
      params: { id: "ws-123" },
      query: {},
    });
    expect(calls[0]?.url).toBe("http://test.local/api/workspaces/ws-123/sessions");
  });

  it("URL-encodes path params", async () => {
    const { client, calls } = makeClient([
      { status: 200, contentType: "application/json", body: "[]" },
    ]);
    await client.call("catalog.skills.get", {
      params: { id: "ws-1", name: "scope/skill name" },
    });
    expect(calls[0]?.url).toBe(
      "http://test.local/api/workspaces/ws-1/catalog/skills/scope%2Fskill%20name",
    );
  });

  it("appends a query string from the query bag, skipping undefined", async () => {
    const { client, calls } = makeClient([
      { status: 200, contentType: "application/json", body: "[]" },
    ]);
    await client.call("tasks.list", {
      params: { id: "ws-1" },
      query: { agent: "writer", runtime: undefined, status: "running,success" },
    });
    expect(calls[0]?.url).toContain("agent=writer");
    expect(calls[0]?.url).toContain("status=running%2Csuccess");
    expect(calls[0]?.url).not.toContain("runtime=");
  });

  it("POST with body sends Content-Type: application/json", async () => {
    const { client, calls } = makeClient([
      {
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "w1", name: "Sandbox", createdAt: "t", workdir: "/x" }),
      },
    ]);
    const ws = await client.call("workspaces.create", {
      body: { name: "Sandbox" },
    });
    expect(ws.id).toBe("w1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ name: "Sandbox" });
  });

  it("DELETE returns undefined on 204 (no body)", async () => {
    const { client } = makeClient([{ status: 204 }]);
    const out = await client.call("workspaces.delete", {
      params: { id: "w1" },
      query: { purge: "1" },
    });
    expect(out).toBeUndefined();
  });

  it("throws ApiError with the parsed body on a 400", async () => {
    const { client } = makeClient([
      {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "name is required (string)" }),
      },
    ]);
    await expect(client.call("workspaces.create", { body: { name: "" } })).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "name is required (string)",
    });
  });

  it("throws ApiError on a non-JSON 5xx", async () => {
    const { client } = makeClient([{ status: 500, contentType: "text/plain", body: "oops" }]);
    try {
      await client.call("health.get");
      expect.fail("expected ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as ApiError).body).toBe("oops");
    }
  });

  it("strips trailing slashes from baseUrl", async () => {
    const calls: CallRecord[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        headers: {},
        body: undefined,
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const c = new ApiClient({ baseUrl: "http://test.local///", fetch: fetchFn });
    await c.call("health.get");
    expect(calls[0]?.url).toBe("http://test.local/api/health");
  });

  it("omits Authorization when no apiKey is configured", async () => {
    const calls: CallRecord[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k] = v;
        }
      }
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        headers,
        body: undefined,
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const c = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    await c.call("health.get");
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("forwards opts.headers verbatim onto the request", async () => {
    const { client, calls } = makeClient([
      { status: 200, contentType: "text/event-stream", body: "" },
    ]);
    // tasks.activity.stream is the canonical caller — Last-Event-ID is
    // the whole reason the headers escape hatch exists.
    await client.callRaw("tasks.activity.stream", {
      params: { id: "ws-1", tid: "20260601-abcd1234" },
      headers: { "Last-Event-ID": "1234" },
    });
    expect(calls[0]?.headers["Last-Event-ID"]).toBe("1234");
    // The built-ins are still set:
    expect(calls[0]?.headers.Accept).toBe("application/json");
    expect(calls[0]?.headers.Authorization).toBe("Bearer secret");
  });

  // Wire-shape pin for the catalog install routes.
  //
  // History: an earlier mismatch had the manifest body type declared
  // as `{ origin: string }` while the server validator expected
  // `{ provider, location }`. The CLI sent what the manifest said,
  // server rejected with 400 "`provider` is required". Caught only
  // when an end-user tried to install. The fix landed in PR #96 by
  // collapsing both sides onto `{ origin }` (canonical URI = single
  // identity used by manifest type, server validator, dashboard
  // post-assembly, CLI, and SKILL.md/AGENTS.md `dependencies:`
  // blocks).
  //
  // These tests pin the wire shape so any future regression that
  // re-introduces the legacy `{ provider, location }` body fails
  // here loudly, before it ever hits a real install.

  it("catalog.skills.install POSTs `{ origin }` (single canonical URI, not provider+location)", async () => {
    const { client, calls } = makeClient([
      {
        status: 201,
        contentType: "application/json",
        body: '{"installed":[],"skipped":[],"failed":[]}',
      },
    ]);
    await client.call("catalog.skills.install", {
      params: { id: "ws-1" },
      body: { origin: "https://github.com/o/r/tree/main/skills/x" },
    });
    expect(calls[0]?.url).toBe("http://test.local/api/workspaces/ws-1/catalog/skills");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      origin: "https://github.com/o/r/tree/main/skills/x",
    });
  });

  it("catalog.agents.install POSTs `{ origin }`", async () => {
    const { client, calls } = makeClient([
      {
        status: 201,
        contentType: "application/json",
        body: '{"installed":[],"skipped":[],"failed":[]}',
      },
    ]);
    await client.call("catalog.agents.install", {
      params: { id: "ws-1" },
      body: { origin: "file:/abs/agent" },
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ origin: "file:/abs/agent" });
  });

  it("catalog.mcps.install POSTs `{ origin }` (no `name` — derived server-side from _meta.name)", async () => {
    const { client, calls } = makeClient([
      {
        status: 201,
        contentType: "application/json",
        body: '{"installed":[],"skipped":[],"failed":[]}',
      },
    ]);
    await client.call("catalog.mcps.install", {
      params: { id: "ws-1" },
      body: { origin: "https://github.com/o/r/tree/main/mcps/x.json" },
    });
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    expect(sent).toEqual({ origin: "https://github.com/o/r/tree/main/mcps/x.json" });
    // Defense-in-depth: the body shape's `name` field was removed from
    // the contract in PR #92 (server derives from _meta.name); ensure
    // no caller is sneakily passing one back in.
    expect("name" in sent).toBe(false);
  });
});
