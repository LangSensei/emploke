import { spawn } from "node:child_process";
import { FetchError } from "./errors.js";

/**
 * Default-token resolution for `AzureDevOpsFetcher`.
 *
 * Two-tier fallback chain — explicit env var first, then `git` credential
 * helper. Designed so the common cases (CI with `SYSTEM_ACCESSTOKEN`, local
 * dev with Git Credential Manager already configured) Just Work without any
 * new emploke configuration:
 *
 *   1. `process.env.AZURE_DEVOPS_EXT_PAT ?? process.env.AZURE_DEVOPS_PAT
 *      ?? process.env.SYSTEM_ACCESSTOKEN` — explicit env always wins.
 *      Returned with `{ source: "env" }` so the caller can skip the
 *      `approve`/`reject` round-trip (env tokens have no GCM entry).
 *   2. `git -c credential.useHttpPath=true credential fill` — invoked once
 *      per `(org, repo)` per {@link CACHE_TTL_MS}. The resolver runs a
 *      **silent peek** first (`GCM_INTERACTIVE=Never` + `-c
 *      credential.interactive=false`) so warm-cache calls produce no
 *      sign-in popup AND no stderr noise. Only when the silent peek
 *      returns nothing AND we are NOT in an explicit opt-out environment
 *      (`CI=true` / `GLYPHS_NON_INTERACTIVE=1`) does the resolver fall
 *      back to the real interactive fill (which is where a Microsoft
 *      sign-in window may appear); the explicit opt-outs short-circuit
 *      with an escape-hatch {@link FetchError} instead of waiting on the
 *      120s interactive bound.
 *   3. `null` — caller emits an anonymous request. Public ADO repos are
 *      rare, so this typically surfaces as a 401/403 from the upstream
 *      Items API with a sensible error message.
 *
 * Why a process-wide cache keyed on `(org, repo)`: a deep dependency
 * closure can fan out to N item fetches; spawning `git` N times would add
 * ~100-200ms × N on Windows. The cache key includes `repo` because GCM
 * may have different cached credentials per repo, so caching only by host
 * would return the wrong cred. 60s is short enough that a
 * `git credential reject` followed by a refresh is reflected within a
 * minute. Stale entries are also explicitly invalidated by
 * {@link invalidateAdoTokenCache} on 401/403 responses, so the next
 * resolve always re-prompts GCM rather than reusing a known-bad token.
 *
 * Why an in-flight `PENDING` map: without it, N concurrent callers on a
 * cold cache (the tree-fan-out case) would all bypass the cache check
 * before the first resolve completes, each spawning `git credential fill`
 * in parallel, each triggering its own GCM popup. The map collapses the
 * fan-out to a single shared `Promise`. Combined with the tree-mode
 * pre-warm in `AzureDevOpsFetcher.fetchTree`, this is belt-and-braces
 * defence against the "8-popup storm" UX failure (see pitfall 21 in
 * `design.md`).
 *
 * Why we never throw on `git` failures: token resolution is best-effort.
 * A `git` failure (binary missing, GCM unconfigured, keyring locked,
 * timeout) must not cascade into "install impossible" — the request
 * always falls through to anonymous, and the upstream HTTP layer surfaces
 * a sensible 401/403 if that turns out to be insufficient.
 *
 * The non-interactive guard now ONLY fast-fails on explicit user
 * opt-outs (`CI=true`, `GLYPHS_NON_INTERACTIVE=1`). For all other
 * environments we proceed to interactive fill and trust GCM to decide
 * whether it can render a popup; the spawn is bounded by
 * `SPAWN_TIMEOUT_MS_INTERACTIVE` (120s) so a truly stuck popup falls
 * through to anonymous rather than hanging the install indefinitely.
 * Rationale: `process.stdin.isTTY` is the wrong signal for popup
 * renderability (Copilot CLI / VS Code tasks / WSL X-forward all hit
 * false negatives), and GCM already does its own GUI-availability
 * detection more accurately than we can.
 */

/**
 * Outcome of a successful credential resolve. `source: "env"` means the
 * token came from one of the supported environment variables and has no
 * associated GCM entry — callers MUST NOT call `gitCredentialApprove` /
 * `gitCredentialReject` for env-var-sourced tokens (those helpers would
 * either be no-ops or, worse, poison GCM's per-org cache with an env-var
 * PAT). `source: "git-credential"` means the token came from `git
 * credential fill`; the caller MUST run the matching `approve` on 2xx and
 * `reject` (plus {@link invalidateAdoTokenCache}) on 401/403 to keep
 * GCM's persistent cache in sync with the server's view of the token.
 */
export type ResolvedAdoToken =
  | { readonly source: "env"; readonly token: string; readonly username?: undefined }
  | { readonly source: "git-credential"; readonly token: string; readonly username: string };

/** Raw `(username, password)` block parsed from `git credential fill`. */
export interface AdoCredential {
  readonly username: string;
  readonly password: string;
}

interface CacheEntry {
  readonly value: ResolvedAdoToken | null;
  readonly expiresAt: number;
}

const CACHE = new Map<string, CacheEntry>();
const PENDING = new Map<string, Promise<ResolvedAdoToken | null>>();
/**
 * Tracks `(org, repo)` pairs we've already logged an "env token in use"
 * notice for. Module-level so a long-running host process emits the line
 * once per pair instead of once per fetch — and so concurrent callers
 * can't race past the dedup check. MUST be cleared in
 * {@link _resetAdoTokenCache} so tests don't leak state across cases.
 */
const ENV_LOG_NOTICE_EMITTED = new Set<string>();
const CACHE_TTL_MS = 60_000;
/**
 * Silent peek MUST be instant (it's a warm-cache hit or fall through to
 * non-zero exit). 5s is a generous ceiling — anything longer is GCM
 * deadlocked and we want to fall through to the next tier quickly.
 */
const SPAWN_TIMEOUT_MS_SILENT = 5_000;
/**
 * Interactive fill spawns a real GCM popup; a user typing MFA codes /
 * approving a notification on a separate device routinely takes 30-60s,
 * and some Conditional Access policies push that toward 90s. 120s is the
 * "if it's not done by now it's stuck" bound — beyond this the install
 * falls through to anonymous rather than hang indefinitely.
 */
const SPAWN_TIMEOUT_MS_INTERACTIVE = 120_000;
/**
 * `git credential approve|reject` are non-interactive housekeeping calls
 * (no popup, no network) — 5s is the right ceiling.
 */
const SPAWN_TIMEOUT_MS_CONFIRM = 5_000;

/**
 * `git -c credential.useHttpPath=true` is the baseline — the
 * `useHttpPath=true` flag is what makes GCM include the request `path=`
 * in its credential lookup key (without it, GCM throws "Cannot determine
 * the organization name for this 'dev.azure.com' remote URL").
 *
 * The silent-peek variant ADDS `-c credential.interactive=false`. Some
 * helpers honour the git-config flag, others honour the `GCM_INTERACTIVE`
 * env var — we pass BOTH so the silent peek survives differences across
 * GCM versions / non-MS credential helpers.
 */
const BASE_GIT_ARGS = ["-c", "credential.useHttpPath=true"] as const;
const SILENT_GIT_ARGS = ["-c", "credential.interactive=false"] as const;
const SILENT_ENV: Readonly<Record<string, string>> = { GCM_INTERACTIVE: "Never" };

interface FillOptions {
  /** When true, suppress the interactive popup — GCM exits non-zero
   *  instead of opening the sign-in window if no cached cred is available. */
  readonly silent?: boolean;
}

/**
 * Spawn `git ... credential fill`, write the per-`(org, repo)` request to
 * stdin, and parse `username=` / `password=` from stdout. Returns `null`
 * (NEVER throws) on any failure mode (spawn ENOENT, non-zero exit,
 * timeout, missing/empty `password=`). The `password=` is treated as
 * OPAQUE — PATs and Azure AD JWTs look completely different so the
 * resolver deliberately does NOT pattern-match the value.
 *
 * `stdio[2]` is `"ignore"` so any GCM stderr (which has historically
 * leaked partial response bodies into log lines) NEVER reaches our error
 * messages. `stdio[0]` MUST be `"pipe"` (not `"ignore"`) because we have
 * to write the `protocol`/`host`/`path` request body — without it, GCM
 * would hang waiting for the request on stdin.
 */
function runGitCredentialFill(
  org: string,
  repo: string,
  opts: FillOptions = {},
): Promise<AdoCredential | null> {
  return new Promise<AdoCredential | null>((resolve) => {
    let settled = false;
    const settle = (v: AdoCredential | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const gitArgs: string[] = [...BASE_GIT_ARGS];
    if (opts.silent) gitArgs.push(...SILENT_GIT_ARGS);
    gitArgs.push("credential", "fill");

    // The silent variant ALSO sets `GCM_INTERACTIVE=Never` in the spawn
    // env (belt-and-braces with the `-c credential.interactive=false`
    // git arg). We only override `env` when needed so the non-silent
    // path inherits the parent env unchanged (Node defaults to inherit).
    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    };
    if (opts.silent) {
      spawnOpts.env = { ...process.env, ...SILENT_ENV };
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", gitArgs, spawnOpts);
    } catch {
      settle(null);
      return;
    }

    // Silent peek must be instant (5s ceiling); interactive fill is
    // bounded by 120s because a real user clicking through MFA can
    // easily take 30-60s and we'd rather give them room than kill the
    // popup mid-sign-in.
    const timeoutMs = opts.silent ? SPAWN_TIMEOUT_MS_SILENT : SPAWN_TIMEOUT_MS_INTERACTIVE;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may already have exited between the timer firing and
        // reaching this line. The `close` listener will settle.
      }
      settle(null);
    }, timeoutMs);

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
      // by a blank line. We care about `username=` (echoed for GCM's
      // approve/reject round-trip) and `password=` (the actual token).
      let username: string | null = null;
      let password: string | null = null;
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("username=")) username = line.slice("username=".length);
        else if (line.startsWith("password=")) password = line.slice("password=".length);
      }
      if (password === null || password.length === 0) {
        settle(null);
        return;
      }
      settle({ username: username ?? "", password });
    });

    const stdin = child.stdin;
    if (stdin === null) {
      // Spawned without a writable stdin — the `close` listener will
      // settle when the child exits.
      return;
    }
    // `path=<org>/_git/<repo>` is REQUIRED for GCM to resolve
    // dev.azure.com credentials; without it GCM throws "Cannot determine
    // the organization name". (See pitfall 1 in the design doc.)
    const request = `protocol=https\nhost=dev.azure.com\npath=${org}/_git/${repo}\n\n`;
    try {
      stdin.write(request, () => {
        try {
          stdin.end();
        } catch {
          // ignore — close listener handles settlement
        }
      });
    } catch {
      // stdin may have closed before the write landed; settle on close.
    }
  });
}

/**
 * Public wrapper for the interactive variant of `git credential fill`.
 * Kept exported (and structurally distinct from the silent peek) so tests
 * can exercise the spawn/parse contract end-to-end without depending on
 * the resolver's UX-detection logic.
 *
 * Returns `{ username, password } | null`. The username is essential for
 * the {@link gitCredentialApprove} / {@link gitCredentialReject}
 * round-trip — GCM keys per-credential entries on `(protocol, host,
 * path, username)` and an approve/reject without the matching username
 * is a silent no-op.
 */
export async function tryGitCredentialFill(
  org: string,
  repo: string,
): Promise<AdoCredential | null> {
  return runGitCredentialFill(org, repo, { silent: false });
}

/**
 * Run `git -c credential.useHttpPath=true credential <approve|reject>`,
 * echoing the full request block (including `username=` and `password=`)
 * back to GCM so it can confirm or discard its cached credential.
 *
 * MUST NOT throw — these are best-effort hygiene calls that the main
 * fetcher path fires-and-forgets after the HTTP response has already
 * resolved. Any internal failure is surfaced via `process.emitWarning`
 * with the matching `EMPLOKE_GCM_*` code and swallowed.
 */
function runGitCredentialConfirm(
  action: "approve" | "reject",
  org: string,
  repo: string,
  username: string,
  password: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const warnCode =
      action === "approve" ? "EMPLOKE_GCM_APPROVE_FAILED" : "EMPLOKE_GCM_REJECT_FAILED";
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const warn = (msg: string): void => {
      try {
        process.emitWarning(msg, { code: warnCode });
      } catch {
        // emitWarning is defensive — never let a logger problem propagate.
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", [...BASE_GIT_ARGS, "credential", action], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (cause) {
      warn(`git credential ${action} spawn failed: ${(cause as Error).message}`);
      settle();
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      warn(`git credential ${action} timed out after ${SPAWN_TIMEOUT_MS_CONFIRM}ms`);
      settle();
    }, SPAWN_TIMEOUT_MS_CONFIRM);

    child.on("error", (cause: Error) => {
      clearTimeout(timer);
      warn(`git credential ${action} errored: ${cause.message}`);
      settle();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        warn(`git credential ${action} exited with code ${code ?? "unknown"}`);
      }
      settle();
    });

    const stdin = child.stdin;
    if (stdin === null) {
      warn(`git credential ${action} spawn produced no writable stdin`);
      return;
    }
    // Echo back the full request block. GCM uses (protocol, host, path,
    // username) as the cache key; omitting the username makes the
    // approve/reject a no-op against the wrong cache entry. The blank
    // line at the end terminates the request.
    const request =
      `protocol=https\nhost=dev.azure.com\npath=${org}/_git/${repo}\n` +
      `username=${username}\npassword=${password}\n\n`;
    try {
      stdin.write(request, () => {
        try {
          stdin.end();
        } catch {
          // ignore
        }
      });
    } catch (cause) {
      warn(`git credential ${action} stdin write failed: ${(cause as Error).message}`);
    }
  });
}

/**
 * Confirm to GCM that the credential previously returned by `fill` was
 * accepted by the server. Run after a 2xx response. NEVER throws — any
 * failure is reported via `process.emitWarning({ code:
 * "EMPLOKE_GCM_APPROVE_FAILED" })` and swallowed.
 *
 * Without this confirmation, GCM treats the credential as untrusted and
 * does NOT persist it to OS-level credential storage (e.g. wincredman on
 * Windows). The next cold-cache call then re-prompts the sign-in UI even
 * though the user successfully authenticated moments earlier. See
 * `design.md` §5.6 for the empirical evidence behind this behaviour.
 */
export async function gitCredentialApprove(
  org: string,
  repo: string,
  username: string,
  password: string,
): Promise<void> {
  await runGitCredentialConfirm("approve", org, repo, username, password);
}

/**
 * Tell GCM that the credential previously returned by `fill` was rejected
 * by the server (typically a 401/403 response). Forces GCM to discard
 * the stale entry so the next `fill` call acquires a fresh credential.
 * NEVER throws — any failure is reported via `process.emitWarning({ code:
 * "EMPLOKE_GCM_REJECT_FAILED" })` and swallowed.
 *
 * The companion {@link invalidateAdoTokenCache} call clears the
 * in-process 60s cache so the next {@link resolveDefaultAdoToken} call
 * doesn't re-return the same stale token before GCM is re-prompted.
 */
export async function gitCredentialReject(
  org: string,
  repo: string,
  username: string,
  password: string,
): Promise<void> {
  await runGitCredentialConfirm("reject", org, repo, username, password);
}

/**
 * Drop the in-process 60s cache entry for a single `(org, repo)` pair.
 * Must be called alongside {@link gitCredentialReject} on a 401/403
 * response, otherwise the next {@link resolveDefaultAdoToken} call would
 * return the cached stale token before GCM gets a chance to issue a
 * fresh one.
 */
export function invalidateAdoTokenCache(org: string, repo: string): void {
  CACHE.delete(`${org}/${repo}`);
}

function readEnvToken(): string | undefined {
  return (
    process.env.AZURE_DEVOPS_EXT_PAT ??
    process.env.AZURE_DEVOPS_PAT ??
    process.env.SYSTEM_ACCESSTOKEN
  );
}

/**
 * Detect a non-interactive runtime where we MUST NOT attempt to open a
 * sign-in popup. Returns `true` on:
 *
 *   - `process.env.CI === "true"` — most CI runners set this; even
 *     environments that allocate a fake TTY (e.g. GitHub Actions) opt
 *     out of interactive auth this way.
 *   - `process.env.GLYPHS_NON_INTERACTIVE === "1"` — explicit opt-out
 *     for users who want fail-fast behaviour even on a real TTY (e.g.
 *     unattended scripts run from a terminal multiplexer).
 */
function isNonInteractive(): boolean {
  // Explicit user opt-outs only. Do NOT infer interactivity from
  // `process.stdin.isTTY` — that detects whether the Node process's
  // stdin is a terminal, NOT whether GCM can render a popup. GCM's
  // popup is a separate WPF/WebView2 window spawned by
  // `git-credential-manager.exe` and depends on OS-level desktop
  // session availability, not on parent process TTY state. Non-TTY
  // child processes on a logged-in desktop (Copilot CLI, VS Code
  // tasks, WSL with X forwarding) can absolutely render the popup.
  //
  // When no display is actually available (CI without an opt-in env,
  // SSH without DISPLAY, SYSTEM service), GCM exits non-zero quickly
  // and the resolver falls through to anonymous on its own — no
  // pre-detection needed.
  if (process.env.GLYPHS_NON_INTERACTIVE === "1") return true;
  if (process.env.CI === "true") return true;
  return false;
}

/**
 * The escape-hatch message used by the non-interactive guard. Includes
 * both the env-var workaround (CI / automated) and the `git ls-remote`
 * workaround (interactive but currently inside a non-TTY shell) so the
 * user gets unambiguous remediation regardless of which environment
 * tripped the guard.
 */
function escapeHatchMessage(org: string, repo: string): string {
  return (
    `ADO authentication required for dev.azure.com/${org}/${repo}.\n` +
    `  Option 1 (CI / non-interactive): set environment variable AZURE_DEVOPS_PAT\n` +
    `    with a Personal Access Token from\n` +
    `    https://dev.azure.com/${org}/_usersSettings/tokens\n` +
    `  Option 2 (interactive): run any git command against the repo first\n` +
    `    (e.g. git ls-remote https://dev.azure.com/${org}/_git/${repo})\n` +
    `    to seed the credential cache, then retry.`
  );
}

/**
 * Core silent-peek → maybe-interactive flow. Throws {@link FetchError}
 * ONLY when we detect a non-interactive runtime with no cached cred and
 * no env-var fallback (the alternative would hang on an invisible
 * popup). Returns `null` on the interactive path if the user cancels the
 * sign-in or `git` fails — caller falls through to anonymous in that case.
 */
async function doResolveWithGcm(org: string, repo: string): Promise<ResolvedAdoToken | null> {
  // Silent peek first — succeeds quietly when GCM already has a cached
  // credential, fails fast (non-zero exit) when it would otherwise pop
  // the sign-in UI. This is what keeps warm-cache calls noise-free.
  const silent = await runGitCredentialFill(org, repo, { silent: true });
  if (silent !== null) {
    return { source: "git-credential", token: silent.password, username: silent.username };
  }
  // Silent peek returned nothing — we'd have to go interactive to get a
  // credential. If we can't, fail loud rather than hang.
  if (isNonInteractive()) {
    const uri = `https://dev.azure.com/${org}/_git/${repo}`;
    throw new FetchError(uri, escapeHatchMessage(org, repo));
  }
  // On a real TTY: warn the user BEFORE the popup so they understand
  // the source of the sign-in window that's about to appear.
  process.stderr.write(
    `[glyphs] Authenticating to dev.azure.com/${org} — a Microsoft sign-in window may appear...\n`,
  );
  const interactive = await runGitCredentialFill(org, repo, { silent: false });
  if (interactive === null) return null;
  return {
    source: "git-credential",
    token: interactive.password,
    username: interactive.username,
  };
}

/**
 * Resolve the default Azure DevOps Services credential for `(org, repo)`.
 * Implements the full chain documented at the top of this file:
 * env-var → silent peek → (TTY ? interactive fill : escape-hatch throw).
 *
 * The env-var check is NOT cached: each call re-reads `process.env` so
 * that a long-lived host process picks up a mid-run env mutation
 * immediately. Only the (relatively expensive) `git credential fill`
 * tier is cached.
 *
 * Concurrent callers for the same `(org, repo)` SHARE a single in-flight
 * Promise via the `PENDING` map. Without this, a tree-fan-out worker
 * pool would all hit the cold-cache resolve in parallel — each spawning
 * its own `git credential fill` — and trigger N parallel GCM popups.
 * Combined with the explicit pre-warm in
 * {@link AzureDevOpsFetcher.fetchTree}, this guarantees at most one
 * popup per tree install. (See pitfall 21 in `design.md`.)
 */
export async function resolveDefaultAdoToken(
  org: string,
  repo: string,
): Promise<ResolvedAdoToken | null> {
  const cacheKey = `${org}/${repo}`;

  const envToken = readEnvToken();
  if (envToken !== undefined) {
    // First-hit-only stderr notice so a long-running host process
    // (e.g. emploke server) doesn't silently keep using an env token
    // that the user thought they'd unset in their interactive shell.
    // The notice fires once per `(org, repo)` to avoid spamming
    // tree-fan-out installs.
    if (!ENV_LOG_NOTICE_EMITTED.has(cacheKey)) {
      ENV_LOG_NOTICE_EMITTED.add(cacheKey);
      process.stderr.write(
        `[glyphs] using ADO token from environment (AZURE_DEVOPS_*_PAT / SYSTEM_ACCESSTOKEN) for dev.azure.com/${org}/${repo}\n`,
      );
    }
    return { source: "env", token: envToken };
  }

  const now = Date.now();
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const inflight = PENDING.get(cacheKey);
  if (inflight) return inflight;

  // Snapshot the resolve in a single Promise that all concurrent callers
  // for this cacheKey share. Cache on success (including a `null` result
  // — negative caching is critical so a workspace with no GCM doesn't
  // spawn `git` once per item across a deep dep graph), do NOT cache on
  // throw (we want the next call to re-attempt rather than re-throw a
  // stale error). The `finally` clears PENDING regardless so a thrown
  // resolve doesn't permanently poison the slot.
  const promise = (async (): Promise<ResolvedAdoToken | null> => {
    try {
      const result = await doResolveWithGcm(org, repo);
      CACHE.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    } finally {
      PENDING.delete(cacheKey);
    }
  })();

  PENDING.set(cacheKey, promise);
  return promise;
}

/**
 * Test-only: clear the per-(org, repo) cache AND the in-flight map
 * between cases. Not exported from the package index — tests reach into
 * this module directly, matching the `_resetGhTokenCache` pattern in
 * `gh-token.ts`.
 */
export function _resetAdoTokenCache(): void {
  CACHE.clear();
  PENDING.clear();
  ENV_LOG_NOTICE_EMITTED.clear();
}
