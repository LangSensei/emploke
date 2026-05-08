import type { LaunchCommand } from "../types.js";

/**
 * Build the launch command for a workdir. Uses `--resume=<id>` to seed the
 * session with a pre-allocated UUID — copilot's `--resume` flag creates a
 * new session at that id when no session exists, and resumes the existing
 * one otherwise. So a single command form works for both first launch and
 * subsequent launches.
 *
 * Bare `copilot` (no args, no `-i`) is the interactive default. The `-i`
 * flag actually means "start interactive AND immediately execute this
 * prompt", so it requires a `<prompt>` argument; passing it bare is wrong.
 *
 * `--yolo` is always appended: dashboard-spawned terminals run in baked
 * workdirs that the user explicitly opted into, so per-action confirmation
 * prompts are pure friction. The flag tells copilot to skip them.
 */
export function buildCopilotLaunchCommand(
  workdir: string,
  runtimeSessionId: string | null,
): LaunchCommand {
  if (runtimeSessionId === null) {
    return {
      cmd: "copilot",
      args: ["--yolo"],
      cwd: workdir,
      display: `cd ${quote(workdir)} && copilot --yolo`,
    };
  }
  const flag = `--resume=${runtimeSessionId}`;
  return {
    cmd: "copilot",
    args: [flag, "--yolo"],
    cwd: workdir,
    display: `cd ${quote(workdir)} && copilot ${flag} --yolo`,
  };
}

/** Minimal cross-platform quoting for display strings (not for shell exec). */
function quote(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}
