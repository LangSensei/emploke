import { spawn } from "node:child_process";

/**
 * Default-token resolution for `AzureDevOpsFetcher`.
 *
 * Two-tier fallback chain (env var first, `git credential fill` second).
 * Designed so the common cases — CI pipelines with `SYSTEM_ACCESSTOKEN`
 * set, local dev with Git Credential Manager already configured — Just
 * Work without any new emploke configuration:
 *
 *   1. `process.env.AZURE_DEVOPS_EXT_PAT ?? process.env.AZURE_DEVOPS_PAT
 *      ?? process.env.SYSTEM_ACCESSTOKEN` — explicit env always wins.
 *      `AZURE_DEVOPS_EXT_PAT` matches the official `az devops` /
 *      `azure-devops` CLI extension's documented env name, `AZURE_DEVOPS_PAT`
 *      is the secondary convention many internal tools use, and
 *      `SYSTEM_ACCESSTOKEN` is the auto-injected pipeline token in Azure
 *      Pipelines jobs.
 *   2. `git -c credential.useHttpPath=true credential fill` — invoked once
 *      per `(org, repo)` per {@link CACHE_TTL_MS}. Captures the token
 *      from the user's existing Git Credential Manager configuration
 *      (PAT, Azure AD JWT, MSAL cached identity, …) without requiring
 *      the user to copy-paste tokens into env vars. `useHttpPath=true`
 *      AND a `path=...` entry in the request body are BOTH required for
 *      `dev.azure.com` — without them GCM cannot determine the
 *      organization name. The flag is passed per-invocation via `git -c`
 *      so we don't depend on user-level git config.
 *   3. `null` — caller emits an anonymous request. Public ADO repos are
 *      rare so this typically surfaces as a 401/403 from the upstream
 *      Items API, with a sensible error message.
 *
 * Why a process-wide cache keyed on `(org, repo)`: a deep dependency
 * closure can fan out to N item fetches; spawning `git` N times would
 * add ~100-200ms × N on Windows. The cache key includes `repo` because
 * GCM may have different cached credentials per repo, so caching only
 * by host would return the wrong cred. 60s is short enough that a
 * `git credential reject` followed by a refresh is reflected within a
 * minute.
 *
 * Why we never throw: token resolution is best-effort. A `git` failure
 * (binary missing, GCM unconfigured, keyring locked, timeout) must not
 * cascade into "install impossible" — the request always falls through
 * to anonymous, and the upstream HTTP layer surfaces a sensible 401/403
 * if that turns out to be insufficient.
 */

interface CacheEntry {
  readonly token: string | null;
  readonly expiresAt: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 5_000;

/**
 * Run `git -c credential.useHttpPath=true credential fill` and return the
 * `password=` value from stdout if successful.
 *
 * Returns `null` (NEVER throws) on any failure mode:
 *   - `git` not installed (spawn ENOENT)
 *   - non-zero exit (GCM not configured, keyring locked, user cancelled, …)
 *   - timeout (`git` hangs > {@link SPAWN_TIMEOUT_MS}, e.g. GCM trying to
 *     pop an interactive auth window on a headless host)
 *   - stdout missing `password=...` line or with an empty value
 *
 * stdin is wired to `"pipe"` (not `"ignore"`) because GCM needs the
 * `protocol=`/`host=`/`path=` request body to determine which ADO
 * organisation it's authenticating against. We write the request, close
 * stdin, and rely on the 5s timeout + `stdio[2] = "ignore"` to keep GCM
 * from blocking on `/dev/tty` if it tries to prompt the user.
 *
 * The token is treated as OPAQUE — we deliberately do NOT pattern-match
 * the value (PATs and Azure AD JWTs have completely different shapes;
 * MSAL tokens may evolve). Empty-string passwords are the only thing
 * we reject.
 */
export async function tryGitCredentialFill(org: string, repo: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const settle = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["-c", "credential.useHttpPath=true", "credential", "fill"], {
        // stdin: pipe — we MUST write the request body.
        // stdout: pipe — read the credentials response.
        // stderr: ignore — GCM may log warnings we don't care about, and
        // any text echoed there must NEVER reach our error messages
        // (token-leak guard: stderr from GCM has historically included
        // partial response bodies).
        stdio: ["pipe", "pipe", "ignore"],
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
        // Ignore — the child may have already exited between the timer
        // firing and reaching this line. The `close` listener below will
        // settle if so.
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
      // `git credential fill` emits one `key=value` per line, terminated
      // by a blank line. We only care about `password=...`.
      const lines = stdout.split(/\r?\n/);
      let password: string | null = null;
      for (const line of lines) {
        if (line.startsWith("password=")) {
          password = line.slice("password=".length);
          break;
        }
      }
      if (password === null || password.length === 0) {
        settle(null);
        return;
      }
      settle(password);
    });

    // Write the credential request. The `path=` entry is what makes
    // GCM able to resolve the org-specific credential for dev.azure.com;
    // without it GCM throws "Cannot determine the organization name".
    const stdin = child.stdin;
    if (stdin === null) {
      // Spawned without a writable stdin — settle as null. The close
      // listener will fire when the child exits.
      return;
    }
    const request = `protocol=https\nhost=dev.azure.com\npath=${org}/_git/${repo}\n\n`;
    try {
      stdin.write(request, () => {
        // Best-effort close; any error here is harmless because the close
        // listener above will settle when the child exits or the timeout
        // fires.
        try {
          stdin.end();
        } catch {
          // ignore
        }
      });
    } catch {
      // stdin may have closed before the write landed; settle on the
      // close listener path.
    }
  });
}

/**
 * Resolve the default Azure DevOps Services token for the given
 * `(org, repo)` pair. Implements the two-tier fallback chain documented
 * at the top of this file. Result is cached per `(org, repo)` for
 * {@link CACHE_TTL_MS} milliseconds. A `null` result is cached too —
 * critical for keeping a workspace with no GCM from spawning `git` once
 * per item fetch across a deep dependency graph.
 *
 * The env-var check is NOT cached: each call re-reads `process.env` so
 * that a long-lived host process picks up a mid-run env mutation
 * immediately. Only the (relatively expensive) `git credential fill`
 * invocation is cached.
 */
export async function resolveDefaultAdoToken(org: string, repo: string): Promise<string | null> {
  const env =
    process.env.AZURE_DEVOPS_EXT_PAT ??
    process.env.AZURE_DEVOPS_PAT ??
    process.env.SYSTEM_ACCESSTOKEN;
  if (env) return env;

  const cacheKey = `${org}/${repo}`;
  const now = Date.now();
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.token;

  const token = await tryGitCredentialFill(org, repo);
  CACHE.set(cacheKey, { token, expiresAt: now + CACHE_TTL_MS });
  return token;
}

/**
 * Test-only: clear the per-(org, repo) cache between cases. Not exported
 * from the package index — tests reach into this module directly,
 * matching the `_resetGhTokenCache` pattern in `gh-token.ts`.
 */
export function _resetAdoTokenCache(): void {
  CACHE.clear();
}
