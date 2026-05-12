/**
 * Typed HTTP client over the route manifest exported by `@emploke/server`.
 *
 * Each call site looks like:
 *
 * ```ts
 * const wsList = await client.call("workspaces.list");
 * const created = await client.call("workspaces.create", {
 *   body: { name: "Sandbox" },
 * });
 * const sessions = await client.call("sessions.list", {
 *   params: { id: workspaceId },
 *   query: { agent: "writer" },
 * });
 * ```
 *
 * The `key` is constrained to `keyof typeof ROUTES`, so:
 *  - typos like `"workspace.list"` fail to compile,
 *  - the `body` / `query` / `params` shapes are the manifest's declared
 *    types,
 *  - the resolved promise type is the manifest's declared response.
 *
 * Because both the server's reflection test and this client read from
 * the same {@link ROUTES} object, **adding a route is impossible without
 * also adding a CLI command, and changing a request shape on either
 * side surfaces as a TypeScript error in the other.**
 *
 * Phase 1 ships this client without any callers — the lifecycle commands
 * (`start` / `stop` / `status` / ...) talk to `runtime.json` and probe
 * `/api/health` directly. Phase 2 will fill `commands/<resource>.ts`
 * with thin wrappers around `apiClient.call(...)`.
 */

import { ROUTES, type RouteKey, type RouteReq, type RouteRes } from "@emploke/server";

/** Extract the request `body` type for route key `K`, or `never` when absent. */
export type BodyOf<K extends RouteKey> =
  RouteReq<(typeof ROUTES)[K]> extends { body: infer B } ? B : never;
/** Extract the request `query` shape for route key `K`, or `never` when absent. */
export type QueryOf<K extends RouteKey> =
  RouteReq<(typeof ROUTES)[K]> extends { query: infer Q } ? Q : never;
/** Extract the path `params` shape for route key `K`, or `never` when absent. */
export type ParamsOf<K extends RouteKey> =
  RouteReq<(typeof ROUTES)[K]> extends { params: infer P } ? P : never;

/**
 * Per-call options object. Each field is required iff the manifest
 * declares it for the route — wrapping the conditional check in a tuple
 * (`[BodyOf<K>] extends [never]`) disables TypeScript's distributive
 * behaviour over `never`, so the type collapses to `never` instead of
 * making body optional everywhere.
 */
export type CallOpts<K extends RouteKey> = ([BodyOf<K>] extends [never]
  ? { readonly body?: never }
  : { readonly body: BodyOf<K> }) &
  ([QueryOf<K>] extends [never] ? { readonly query?: never } : { readonly query?: QueryOf<K> }) &
  ([ParamsOf<K>] extends [never] ? { readonly params?: never } : { readonly params: ParamsOf<K> });

/**
 * Thrown when the server responds with a non-2xx / non-204 status.
 * `body` is the parsed response payload (JSON when the response was
 * `application/json`; raw text otherwise) so callers can pattern-match
 * on `body.code` / `body.error` from the standard error envelope.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOpts {
  /** Base URL the server is listening on (no trailing slash). */
  readonly baseUrl: string;
  /** Bearer token sent on every request when set. */
  readonly apiKey?: string;
  /** Override `globalThis.fetch` (for tests, polyfills, agents). */
  readonly fetch?: typeof fetch;
}

/**
 * Has-required-field test, robust against `Record<string, never>` and
 * `never`-valued optional fields. Walks each key, checks whether
 * picking just that key gives a type the empty object satisfies — if
 * yes, the field is optional. The result is the union of required
 * keys; `never` means "every field is optional".
 *
 * Used to make the `opts` argument of `call(...)` mandatory only when
 * the route actually requires one — `client.call("health.get")` should
 * compile without a second argument.
 */
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];
type HasRequired<T> = [RequiredKeys<T>] extends [never] ? false : true;

/**
 * Resolves to either `[opts]` or `[opts?]`, used as a rest param so
 * `call("health.get")` (no opts) and `call("workspaces.create", {body})`
 * (opts mandatory) both type-check.
 */
type CallArgs<K extends RouteKey> =
  HasRequired<CallOpts<K>> extends true ? [opts: CallOpts<K>] : [opts?: CallOpts<K>];

/**
 * Typed HTTP client. Stateless beyond the constructor; safe to share
 * across concurrent commands. URL building, header threading, and
 * JSON encode/decode are all centralised here so per-command code
 * stays one line.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(opts: ApiClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async call<K extends RouteKey>(
    key: K,
    ...rest: CallArgs<K>
  ): Promise<RouteRes<(typeof ROUTES)[K]>> {
    const res = await this.callRaw(key, ...rest);

    if (res.status === 204) {
      // void responses; return undefined cast to the declared (likely void)
      // response type. The phantom `_res` exists at the type level only.
      return undefined as RouteRes<(typeof ROUTES)[K]>;
    }

    const ct = res.headers.get("content-type") ?? "";
    let payload: unknown;
    if (ct.includes("application/json")) {
      payload = await res.json();
    } else {
      payload = await res.text();
    }

    if (!res.ok) {
      const message =
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof (payload as { error: unknown }).error === "string"
          ? (payload as { error: string }).error
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, message, payload);
    }
    return payload as RouteRes<(typeof ROUTES)[K]>;
  }

  /**
   * Issue the request without buffering / parsing the response body.
   * Returns the raw {@link Response} so the caller can stream `res.body`
   * directly — necessary for endpoints that may deliver an arbitrarily-
   * large payload over a long-running connection. The caller is
   * responsible for:
   *   - checking `res.ok` / `res.status`
   *   - draining or piping `res.body`
   *   - throwing {@link ApiError} on non-2xx if that's the desired UX
   *
   * For everything else, prefer {@link call} — it does the parse-and-throw
   * dance for you.
   */
  async callRaw<K extends RouteKey>(key: K, ...rest: CallArgs<K>): Promise<Response> {
    const route = ROUTES[key];
    const opts = rest[0] as
      | {
          body?: unknown;
          query?: Record<string, string | number | undefined | null>;
          params?: Record<string, string | number>;
        }
      | undefined;

    let path = route.path;
    if (opts?.params) {
      for (const [name, value] of Object.entries(opts.params)) {
        path = path.replace(`:${name}`, encodeURIComponent(String(value)));
      }
    }
    if (opts?.query) {
      const usp = new URLSearchParams();
      for (const [name, value] of Object.entries(opts.query)) {
        if (value === undefined || value === null) continue;
        usp.append(name, String(value));
      }
      const qs = usp.toString();
      if (qs) path += `?${qs}`;
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const init: RequestInit = { method: route.method, headers };
    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const url = `${this.baseUrl}${path}`;
    return this.fetchFn(url, init);
  }
}
