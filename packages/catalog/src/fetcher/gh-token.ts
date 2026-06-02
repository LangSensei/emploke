import { spawn } from "node:child_process";

/**
 * Default-token resolution for `GitHubFetcher`.
 *
 * Two-tier fallback chain (env var first, gh CLI second). Designed so the
 * common cases — CI with `GITHUB_TOKEN` set, local dev with `gh auth login`
 * — Just Work without any new emploke configuration:
 *
 *   1. `process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN` — explicit env
 *      always wins. Preserves existing CI behaviour and lets advanced users
 *      override the gh fallback per-process.
 *   2. `gh auth token --hostname <host>` — invoked once per host per
 *      `CACHE_TTL_MS`. Captures the token from the user's existing
 *      `gh auth login` flow (including SSO-authorized EMU accounts) without
 *      requiring the user to copy-paste tokens into env vars.
 *   3. `null` — caller emits an anonymous request. Same as today's
 *      no-env-var behaviour; public github.com repos still work, private
 *      repos return 404.
 *
 * Why a process-wide cache: a deep dependency closure can fan out to N
 * tarball fetches; spawning `gh` N times would add ~200ms × N on Windows.
 * 60s is short enough that `gh auth switch --user X` is reflected within
 * a minute (or instantly on a fresh emploke process).
 *
 * Why we never throw: token resolution is best-effort. A `gh` failure must
 * not cascade into "install impossible" — the request always falls through
 * to anonymous, and the upstream HTTP layer surfaces a sensible 401/404 if
 * that turns out to be insufficient.
 */

interface CacheEntry {
  readonly token: string | null;
  readonly expiresAt: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 5_000;

/**
 * Recognised GitHub token prefixes (per
 * https://github.blog/changelog/2021-03-31-authentication-token-format-updates/):
 *   - `gho_` OAuth, `ghp_` PAT, `ghs_` server-to-server, `ghu_` user-to-server,
 *   - `github_pat_` fine-grained PAT.
 *
 * Defensive validation: if `gh auth token` ever prints stderr text on stdout
 * (or a future gh version changes its output shape), this regex prevents us
 * from sending garbage into an `Authorization: Bearer …` header.
 */
const TOKEN_RE = /^(gho|ghp|ghs|ghu|github_pat)_[A-Za-z0-9_]+$/;

/**
 * Run `gh auth token --hostname <host>` and return the token if successful.
 *
 * Returns `null` (NEVER throws) on any failure mode:
 *   - `gh` CLI not installed (spawn ENOENT)
 *   - non-zero exit (no auth, locked keyring, host not configured, …)
 *   - timeout (`gh` hangs > {@link SPAWN_TIMEOUT_MS} — defends against
 *     edge cases where gh tries to prompt on stdin)
 *   - stdout doesn't match {@link TOKEN_RE}
 *
 * Stdin is wired to `"ignore"` so `gh` can never prompt the user for input.
 * If the keyring is locked or the user isn't logged in, gh exits non-zero
 * immediately rather than blocking — but the timeout is the belt-and-braces
 * fallback in case some future gh version behaves differently.
 *
 * Host names are lower-cased before being passed to `gh`. Hostnames are
 * case-insensitive at the DNS / `gh` level, but the cache in
 * {@link resolveDefaultGitHubToken} keys on the canonical form, so this
 * function lower-cases too for consistency.
 */
export async function tryGhAuthToken(host: string): Promise<string | null> {
  const normalisedHost = host.toLowerCase();
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const settle = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("gh", ["auth", "token", "--hostname", normalisedHost], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      settle(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore — the child may have already exited between the timer firing
        // and reaching this line. The `close` listener below will settle.
      }
      settle(null);
    }, SPAWN_TIMEOUT_MS);

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      settle(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(null);
        return;
      }
      const trimmed = stdout.trim();
      if (TOKEN_RE.test(trimmed)) {
        settle(trimmed);
        return;
      }
      // Distinct case from "gh isn't configured here": gh exited 0 but the
      // stdout isn't a recognised GitHub token shape. That means either
      // (a) a future gh version changed its output format, or (b) something
      // else printed to stdout (extension wrapper, login banner, …).
      // Either way it's an unexpected condition the user almost certainly
      // wants to know about — emit a one-shot Node warning so it surfaces
      // in CI logs and process.on("warning") handlers without forcing the
      // fetcher subdir to depend on a logger (it's the lowest layer of the
      // package and is reachable before any caller has constructed one).
      process.emitWarning(
        `gh auth token --hostname ${normalisedHost} returned data that does not look like a GitHub token; ` +
          "treating as no token and falling back to anonymous request",
        { code: "EMPLOKE_GH_TOKEN_FORMAT" },
      );
      settle(null);
    });
  });
}

/**
 * Resolve the default GitHub token for `host`. Implements the two-tier
 * fallback chain documented at the top of this file. Result is cached
 * per-host (case-insensitive) for {@link CACHE_TTL_MS} milliseconds.
 *
 * The env-var check is NOT cached: each call re-reads `process.env` so that
 * a long-lived host process picks up a mid-run env mutation immediately.
 * Only the `gh auth token` invocation (the expensive one) is cached.
 */
export async function resolveDefaultGitHubToken(host: string): Promise<string | null> {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;

  const cacheKey = host.toLowerCase();
  const now = Date.now();
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.token;

  const token = await tryGhAuthToken(cacheKey);
  CACHE.set(cacheKey, { token, expiresAt: now + CACHE_TTL_MS });
  return token;
}

/**
 * Test-only: clear the per-host cache between cases. Not exported from
 * the package index — tests reach into this module directly.
 */
export function _resetGhTokenCache(): void {
  CACHE.clear();
}
