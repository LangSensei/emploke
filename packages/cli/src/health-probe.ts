/**
 * HTTP probe against `/api/health`.
 *
 * Used by:
 *  - `emploke start` — poll until the freshly-spawned server is ready.
 *  - `emploke status` — report whether a recorded pid is actually
 *    serving requests.
 *
 * The endpoint is unauthenticated (see `packages/server/src/routes/health.ts`)
 * so we do NOT thread the API key through here; that would force every
 * caller to plumb auth through code paths that don't need it.
 */

/**
 * Subset of the server's `HealthResponse` we surface. Mirrors the wire
 * shape declared in `packages/server/src/routes/health.ts`; duplicated
 * here so the CLI doesn't need a build-time dep on the server's types
 * for a tiny payload.
 */
export interface HealthSnapshot {
  readonly status: "ok";
  readonly name: string;
  readonly version: string;
  readonly startedAt: string;
  readonly uptimeSec: number;
  readonly serverNow: string;
}

export interface ProbeOpts {
  readonly host: string;
  readonly port: number;
  /** Per-attempt timeout. Default 1500 ms. */
  readonly timeoutMs?: number;
}

/**
 * Single-shot probe. Returns the health snapshot on a 200, `null` on
 * any other outcome (network error, non-200, timeout) so the caller
 * can treat "absent" and "wrong" identically — both mean "don't trust
 * this pid".
 *
 * `0.0.0.0` is rewritten to `127.0.0.1` for the connect — the server
 * binds the wildcard but `fetch("http://0.0.0.0/...")` is platform-
 * dependent (works on linux, fails on macos/windows).
 */
export async function probeHealth(opts: ProbeOpts): Promise<HealthSnapshot | null> {
  const host = opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
  const url = `http://${host}:${opts.port}/api/health`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (res.status !== 200) return null;
    const body = (await res.json()) as HealthSnapshot;
    if (body?.status !== "ok") return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll `/api/health` until success or `totalMs` elapses. Used by
 * `start` to convert "process spawned" into "server actually accepting
 * requests".
 *
 * The poll interval grows from 50 ms to 250 ms — fast enough that a
 * fast-booting server is detected within ~100 ms, slow enough that a
 * slow one doesn't hammer the loopback socket with hundreds of
 * connection attempts.
 */
export async function waitForHealth(
  opts: ProbeOpts & { readonly totalMs: number },
): Promise<HealthSnapshot | null> {
  const deadline = Date.now() + opts.totalMs;
  let intervalMs = 50;
  while (Date.now() < deadline) {
    const snap = await probeHealth(opts);
    if (snap) return snap;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
    intervalMs = Math.min(250, Math.floor(intervalMs * 1.5));
  }
  return null;
}
