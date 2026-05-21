import type { BuildInteractiveLaunchOpts, LaunchCommand } from "../types.js";

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
 *
 * `opts.remote === true` adds `--remote`, which puts the CLI into
 * remote-control mode (a link + QR code in the terminal lets the user
 * steer the session from a browser / mobile app). When false / absent
 * the launch behaves exactly as before. The flag goes BEFORE `--yolo`
 * for readability — `--remote` is the user-meaningful bit, `--yolo` is
 * always-on dashboard plumbing.
 */
export function buildCopilotLaunchCommand(
  workdir: string,
  runtimeSessionId: string | null,
  opts: BuildInteractiveLaunchOpts = {},
): LaunchCommand {
  const args: string[] = [];
  if (runtimeSessionId !== null) args.push(`--resume=${runtimeSessionId}`);
  if (opts.remote === true) args.push("--remote");
  args.push("--yolo");
  return {
    cmd: "copilot",
    args,
    cwd: workdir,
    display: `cd ${quote(workdir)} && copilot ${args.join(" ")}`,
  };
}

/** Minimal cross-platform quoting for display strings (not for shell exec). */
function quote(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}
