import path from "node:path";

/**
 * Path-traversal defense. Given a validated id (caller has already run
 * `assertValidTaskId`), construct the workdir path and assert it is a
 * proper child of root. Throws on escape or aliasing-equality.
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
