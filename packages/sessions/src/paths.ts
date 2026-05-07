import { realpath as realpathCallback } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// Use realpath.native (resolves on the OS layer; matters on Windows for
// 8.3 short names and case canonicalization). The promises API doesn't
// expose a typed `.native`, so promisify the callback form here.
const realpathNative = promisify(realpathCallback.native);

/**
 * Lexically normalize a cwd: absolute path, no trailing separators,
 * lower-cased on Windows for case-insensitive comparison.
 *
 * macOS volumes can be either case-sensitive (APFS default) or case-insensitive
 * (HFS+ default, opt-in APFS). We do NOT case-fold on macOS; users with
 * case-insensitive volumes whose cwd capitalization varies may see misses.
 */
export function normalizeCwd(p: string): string {
  let resolved = path.resolve(p);
  // Strip trailing separators only when not at the volume root. On Windows
  // `path.parse("C:\\").root === "C:\\"` — stripping that would yield "C:"
  // which has different semantics. On POSIX the root is "/".
  const root = path.parse(resolved).root;
  if (resolved !== root) {
    resolved = resolved.replace(/[/\\]+$/, "");
  }
  if (process.platform === "win32") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

/**
 * Resolve symlinks where possible. Returns the realpath if the path exists,
 * otherwise falls back to lexical normalization. Always returns a fully
 * normalized form.
 */
export async function realNormalizeCwd(p: string): Promise<string> {
  try {
    const real = await realpathNative(p);
    return normalizeCwd(real);
  } catch {
    // Path doesn't exist or can't be realpathed — fall back to lexical.
    return normalizeCwd(p);
  }
}

/**
 * Path-traversal defense. Given a validated id (caller has already run
 * assertValidSessionId), construct the workdir path and assert it is a child
 * of root. Throws if not.
 */
export function safeJoinUnderRoot(root: string, id: string): string {
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, id);
  // Use a separator-suffixed root so /a/b is not considered a child of /a/bb.
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  if (!candidate.startsWith(rootWithSep) && candidate !== normalizedRoot) {
    throw new Error(`refused: candidate path escapes root (${candidate} not under ${rootWithSep})`);
  }
  // The candidate must not equal root itself.
  if (candidate === normalizedRoot) {
    throw new Error(`refused: candidate path equals root`);
  }
  return candidate;
}
