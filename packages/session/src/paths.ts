import path from "node:path";

/** Subdirectory under `<workspaceDir>/` where per-session workdirs live. */
export const SESSIONS_SUBDIR = "sessions";

/** Resolve the absolute root directory for this workspace's session workdirs. */
export function sessionsRoot(workspaceDir: string): string {
  return path.join(workspaceDir, SESSIONS_SUBDIR);
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
  if (candidate === normalizedRoot) {
    throw new Error("refused: candidate path equals root");
  }
  return candidate;
}
