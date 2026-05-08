import type { LaunchCommand } from "./types.js";

/** Validate Copilot's session id format (UUID v4-ish; we accept any 8-4-4-4-12 hex). */
const COPILOT_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCopilotSessionId(s: string): boolean {
  return typeof s === "string" && COPILOT_SESSION_ID_RE.test(s);
}

/**
 * Build the launch command for a workdir (no resume).
 * Resulting `display` is shell-friendly with the cwd quoted.
 */
export function buildLaunchCommand(workdir: string): LaunchCommand {
  return {
    cmd: "copilot",
    args: ["-i"],
    cwd: workdir,
    display: `cd ${quote(workdir)} && copilot -i`,
  };
}

/**
 * Build the resume command for a workdir + Copilot session id.
 * Caller MUST have validated `copilotSessionId` via isCopilotSessionId.
 */
export function buildResumeCommand(workdir: string, copilotSessionId: string): LaunchCommand {
  return {
    cmd: "copilot",
    args: ["-i", "--resume", copilotSessionId],
    cwd: workdir,
    display: `cd ${quote(workdir)} && copilot -i --resume ${copilotSessionId}`,
  };
}

/** Minimal cross-platform quoting for display strings (not for shell exec). */
function quote(p: string): string {
  // Escape any embedded double-quotes; wrap in double-quotes.
  return `"${p.replace(/"/g, '\\"')}"`;
}
