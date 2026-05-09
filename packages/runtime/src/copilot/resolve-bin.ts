import { execFileSync as nodeExecFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Reason why a particular bin candidate was selected. Surfaced in
 * diagnostics so callers can explain to users which install was chosen.
 */
export type CopilotBinResolutionReason =
  | "configured" // caller passed an absolute path (and it's not the shim)
  | "winget-package" // detected WinGet shim, swapped to real packaged binary
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
 * Escape hatch for the WinGet `copilot` shim on Windows.
 *
 * **This is not a general-purpose path resolver.** It exists solely to
 * compensate for a bug in the WinGet shim: the shim at
 * `%LOCALAPPDATA%\Microsoft\WinGet\Links\copilot.exe` works fine when
 * launched from a console (PowerShell, cmd) but, when spawned by a
 * non-console parent (Node `child_process.spawn`), corrupts stdout and
 * reports exit code 1 even on successful runs. Empirically: same
 * `copilot -p test --allow-all ...` invocation — exit=0 and 15 KB of
 * output via PowerShell, exit=1 and zero output via Node `spawn`.
 *
 * To make WinGet-installed Copilot usable through emploke's autonomous
 * task dispatch, this resolver detects when the configured `bin` (or
 * PATH lookup) points at the shim and substitutes the real packaged
 * binary at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.Copilot_*\
 * copilot.exe`, which behaves correctly under non-console spawn.
 *
 * Resolution order on Windows:
 *   1. If `bin` is an absolute path that is NOT the WinGet shim, return
 *      it untouched. (Caller knows what they want.)
 *   2. If a WinGet packages dir contains a real Copilot binary, return
 *      that.
 *   3. Otherwise return `bin` unchanged and let `child_process.spawn`
 *      (or whoever) deal with PATH lookup. WinGet users without the
 *      packaged binary on disk will still hit the shim bug; that's the
 *      pre-resolver baseline.
 *
 * Implementation note on path APIs: this function operates exclusively
 * on Windows-shaped paths (drive letters, backslash separators). All
 * `path.X` calls inside the win32 branch use `path.win32.X` so the
 * tests that mock `platform: "win32"` on POSIX runners produce the same
 * results as the win32 branch on a real Windows host. The function
 * still early-returns on non-win32 platforms, so production behaviour
 * is unaffected.
 *
 * Lifecycle: this whole file is a temporary compatibility layer. When
 * the upstream WinGet / Copilot install story stops needing it, delete
 * the file and have `dispatchCopilotTask` call `spawn("copilot", ...)`
 * directly. See {@link https://github.com/LangSensei/emploke/issues/27}.
 */
export function resolveCopilotBin(
  bin: string,
  deps: ResolveCopilotBinDeps = {},
): ResolvedCopilotBin {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return { bin, reason: "path-passthrough" };
  }

  // Use win32-shaped path APIs explicitly so this branch behaves the same
  // when invoked on a POSIX runner with `platform: "win32"` mocked. On a
  // real Windows host `path === path.win32`, so production behaviour is
  // unchanged.
  const win = path.win32;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const readdir = deps.readdir ?? readdirSync;
  const which = deps.which ?? defaultWhich;

  // If the caller supplied an absolute path and it is not the shim, trust it.
  if (win.isAbsolute(bin)) {
    if (!isWingetShim(bin, env)) {
      return { bin, reason: "configured" };
    }
    // Configured to the shim explicitly — fall through to redirect.
  }

  // Resolve PATH so we can detect whether `copilot` would land on the shim.
  let pathHit: string | null = null;
  try {
    pathHit = which(win.basename(bin, ".exe"));
  } catch {
    pathHit = null;
  }
  const isShimOnPath = pathHit !== null && isWingetShim(pathHit, env);

  // Prefer real WinGet package binary when available.
  const wingetReal = findWingetPackageBin(env, exists, readdir);
  if (wingetReal !== null) {
    return { bin: wingetReal, reason: "winget-package" };
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
  const linksDir = path.win32.join(localAppData, "Microsoft", "WinGet", "Links").toLowerCase();
  return path.win32.dirname(p).toLowerCase() === linksDir;
}

function findWingetPackageBin(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  readdir: (p: string) => readonly string[],
): string | null {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return null;
  const packagesRoot = path.win32.join(localAppData, "Microsoft", "WinGet", "Packages");
  if (!exists(packagesRoot)) return null;

  let entries: readonly string[];
  try {
    entries = readdir(packagesRoot);
  } catch {
    return null;
  }

  const copilotDir = entries.find((name) => name.toLowerCase().startsWith("github.copilot_"));
  if (!copilotDir) return null;

  const candidate = path.win32.join(packagesRoot, copilotDir, "copilot.exe");
  return exists(candidate) ? candidate : null;
}
