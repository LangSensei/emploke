import path from "node:path";

/**
 * Path-traversal defense. Given a validated id (caller has already run
 * `assertValidTaskId`), construct the workdir path and assert it is a
 * proper child of root. Throws on escape or aliasing-equality.
 *
 * Note on case-insensitive filesystems (Windows NTFS default, macOS APFS
 * default): the prefix check below is byte-exact, so two ids that differ
 * only in case (e.g. `20260101-DEADBEEF` vs `20260101-deadbeef`) would
 * resolve to the same directory while passing this check. Today's task
 * id format is all-lowercase + digits (`assertValidTaskId` enforces it
 * via `TASK_ID_RE`), so no two valid ids can collide on disk. If the
 * id alphabet ever broadens, this function needs a case-aware
 * uniqueness check on top of the prefix guard.
 */
export function safeJoinUnderRoot(root: string, id: string): string {
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, id);
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
