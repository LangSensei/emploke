import { execFileSync as nodeExecFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Reason why a particular bin candidate was selected. Surfaced in
 * diagnostics so callers can explain to users which install was chosen.
 */
export type CopilotBinResolutionReason =
  | "configured" // caller passed an absolute path
  | "winget-package" // detected WinGet shim, swapped to real binary
  | "npm-package" // found node_modules/@github/copilot binary
  | "path-passthrough"; // no Windows-specific shim found, hand back to spawn

export interface ResolvedCopilotBin {
  readonly bin: string;
  readonly reason: CopilotBinResolutionReason;
}

export interface ResolveCopilotBinDeps {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam for `where <cmd>` lookup. Returns the first PATH match or null. */
  readonly which?: (cmd: string) => string | null;
  /** Test seam for fs.existsSync. */
  readonly exists?: (p: string) => boolean;
  /** Test seam for fs.readdirSync. */
  readonly readdir?: (p: string) => readonly string[];
}

/**
 * Resolve the `copilot` binary path for non-console spawning on Windows.
 *
 * Why this exists: the WinGet shim copilot.exe at
 * `%LOCALAPPDATA%\Microsoft\WinGet\Links\copilot.exe` works fine when
 * launched from a console (PowerShell, cmd) but corrupts stdout and
 * returns exit code 1 — even on successful runs — when spawned by a
 * non-console parent (Node `child_process.spawn`, Python `subprocess`,
 * etc.). Empirically: same `copilot -p test --allow-all ...` invocation,
 * exit=0 and 15 KB of output via PowerShell, exit=1 and zero output via
 * Node spawn. Investigation traced the issue to the shim swallowing the
 * underlying process's exit code and stdout when no console is attached.
 *
 * This resolver detects when the configured `bin` (or PATH lookup)
 * points at the shim and substitutes the real packaged binary at
 * `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.Copilot_*\copilot.exe`,
 * which behaves correctly under non-console spawn.
 *
 * Resolution order, on Windows:
 *   1. If `bin` is an absolute path that is NOT the WinGet shim, return it.
 *      (Caller knows what they want.)
 *   2. If a WinGet packages dir contains a real Copilot binary, prefer that.
 *   3. If a node_modules `@github/copilot` install exists in any ancestor
 *      of cwd, prefer that as a fallback.
 *   4. Otherwise return `bin` unchanged and let `child_process.spawn`
 *      (or whoever) deal with PATH lookup.
 *
 * On non-Windows platforms this is a no-op pass-through.
 */
export function resolveCopilotBin(
  bin: string,
  deps: ResolveCopilotBinDeps = {},
): ResolvedCopilotBin {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return { bin, reason: "path-passthrough" };
  }

  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const readdir = deps.readdir ?? readdirSync;
  const which = deps.which ?? defaultWhich;

  // If the caller supplied an absolute path and it is not the shim, trust it.
  if (path.isAbsolute(bin)) {
    if (!isWingetShim(bin, env)) {
      return { bin, reason: "configured" };
    }
    // Configured to the shim explicitly — fall through to redirect.
  }

  // Resolve PATH so we can detect whether `copilot` would land on the shim.
  let pathHit: string | null = null;
  try {
    pathHit = which(path.basename(bin, ".exe"));
  } catch {
    pathHit = null;
  }
  const isShimOnPath = pathHit !== null && isWingetShim(pathHit, env);

  // Prefer real WinGet package binary when available.
  const wingetReal = findWingetPackageBin(env, exists, readdir);
  if (wingetReal !== null) {
    return { bin: wingetReal, reason: "winget-package" };
  }

  // Try npm install (project-local node_modules ancestor walk would be
  // overkill; the package is installed globally for most users, and we
  // only fall back here when WinGet wasn't found).
  const npmReal = findNpmPackageBin(env, exists);
  if (npmReal !== null) {
    return { bin: npmReal, reason: "npm-package" };
  }

  // Last resort: hand back what we were given. If it was the shim, the
  // caller will still hit the bug — but at least the failure mode is
  // unchanged from the pre-resolver baseline.
  if (isShimOnPath && pathHit !== null) {
    return { bin: pathHit, reason: "path-passthrough" };
  }
  return { bin, reason: "path-passthrough" };
}

function defaultWhich(cmd: string): string | null {
  try {
    const out = nodeExecFileSync("where", [cmd], {
      encoding: "utf8",
      windowsHide: true,
    });
    const first = out.split(/\r?\n/)[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

function isWingetShim(p: string, env: NodeJS.ProcessEnv): boolean {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return false;
  const linksDir = path.join(localAppData, "Microsoft", "WinGet", "Links").toLowerCase();
  return path.dirname(p).toLowerCase() === linksDir;
}

function findWingetPackageBin(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  readdir: (p: string) => readonly string[],
): string | null {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return null;
  const packagesRoot = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  if (!exists(packagesRoot)) return null;

  let entries: readonly string[];
  try {
    entries = readdir(packagesRoot);
  } catch {
    return null;
  }

  const copilotDir = entries.find((name) => name.toLowerCase().startsWith("github.copilot_"));
  if (!copilotDir) return null;

  const candidate = path.join(packagesRoot, copilotDir, "copilot.exe");
  return exists(candidate) ? candidate : null;
}

function findNpmPackageBin(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  // Probe a small set of conventional global install roots. Best-effort.
  const candidates: string[] = [];
  if (env.APPDATA) {
    candidates.push(
      path.join(
        env.APPDATA,
        "npm",
        "node_modules",
        "@github",
        "copilot",
        "node_modules",
        "@github",
        "copilot-win32-x64",
        "copilot.exe",
      ),
    );
  }
  // nvm-windows / scoop layout: the active node has its own
  // node_modules dir.
  if (env.NVM_SYMLINK) {
    candidates.push(
      path.join(
        env.NVM_SYMLINK,
        "node_modules",
        "@github",
        "copilot",
        "node_modules",
        "@github",
        "copilot-win32-x64",
        "copilot.exe",
      ),
    );
  }
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}
