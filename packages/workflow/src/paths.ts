import path from "node:path";

/** Subdirectory under `<workspaceDir>/` where per-workflow workdirs live. */
export const WORKFLOW_SUBDIR = "workflows";

/** Subdirectory under `<workflowDir>/` where per-node workdirs live. */
export const WORKFLOW_NODES_SUBDIR = "nodes";

/** Resolve the absolute root directory for this workspace's workflow workdirs. */
export function workflowRoot(workspaceDir: string): string {
  return path.join(workspaceDir, WORKFLOW_SUBDIR);
}

/**
 * Path-traversal defense. Given a validated id (caller has already
 * run `assertValidWorkflowId` / `assertValidWorkflowNodeId`),
 * construct the workdir path and assert it is a proper child of
 * root. Throws on escape or aliasing-equality.
 */
export function safeJoinUnderRoot(root: string, id: string): string {
  // Defense in depth: even though callers should have already run
  // `assertValidWorkflowId` / `assertValidWorkflowNodeId`, reject
  // components that would collapse `path.resolve` back onto the root
  // (empty / "." / "..") or smuggle separators / null bytes.
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error(`invalid workflow path component: ${JSON.stringify(id)}`);
  }
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

/** Resolve `<workspaceDir>/workflows/<workflowId>/`. */
export function workflowDir(workspaceDir: string, workflowId: string): string {
  return safeJoinUnderRoot(workflowRoot(workspaceDir), workflowId);
}

/**
 * Resolve `<workspaceDir>/workflows/<workflowId>/nodes/<nodeId>/`.
 * Every node owns a sibling sub-directory under the workflow's
 * shared scratch dir, so a `kind='task'` node can hand the resulting
 * path straight to the task manager as the task's `workdir`.
 */
export function workflowNodeDir(workspaceDir: string, workflowId: string, nodeId: string): string {
  const wfDir = workflowDir(workspaceDir, workflowId);
  return safeJoinUnderRoot(path.join(wfDir, WORKFLOW_NODES_SUBDIR), nodeId);
}
