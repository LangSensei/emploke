/**
 * File-based task brief + details contract.
 *
 * The Task layer materializes the user-supplied `brief` (+ optional
 * `details`) to a file inside the task workdir (`TASK.md`) and creates
 * two empty agent-managed subdirectories (`temp/` for scratch,
 * `artifact/` for user-visible output). The runtime then receives
 * only a short, fixed ASCII framing prompt that points the agent at
 * those files.
 *
 * Why: on Windows, `cmd.exe` treats LF inside a `/c` payload as a
 * statement separator. Any user-supplied LF in the spawn argv would
 * truncate the copilot CLI's argument list, dropping
 * `--output-format json`, `--session-id`, `--allow-all` etc., causing
 * silent task degradation. Moving user bytes out of argv eliminates
 * that class of bug entirely — the framing prompt is a fixed
 * single-line ASCII string we author ourselves, so there are no
 * user-controlled bytes in argv ever.
 *
 * The runtime layer remains unchanged: it still receives `prompt` as
 * a single argv element via {@link import("@emploke/runtime").LaunchHeadlessOpts}.
 * Only the *value* changes — from the user-supplied bytes to a fixed
 * framing prompt that tells the agent to read TASK.md.
 */

/** Filename inside the task workdir holding the user-authored brief + details. */
export const TASK_FILENAME = "TASK.md";

/** Subdirectory inside the task workdir for agent scratch files. Agent-managed; not surfaced to the user. */
export const TASK_TEMP_SUBDIR = "temp";

/** Subdirectory inside the task workdir for user-visible task output. Agent-managed. */
export const TASK_ARTIFACT_SUBDIR = "artifact";

/**
 * Single-line ASCII framing prompt for the copilot runtime.
 *
 * Kept on ONE line so `cmd.exe` never sees an LF inside the `/c`
 * payload (see module docstring for the cmd.exe argv-LF interaction).
 *
 * Do NOT edit this constant to span multiple lines. The startup-time
 * invariant guard ({@link assertFramingPromptIsSafe}) will reject any
 * value containing LF / CR / non-printable-ASCII bytes at module load.
 */
export const TASK_FRAMING_PROMPT_COPILOT =
  "1. Read TASK.md in your current working directory. That is your assignment. 2. Use ./temp/ for intermediate steps and scratch files; nothing in ./temp/ is shown to the user. 3. Save meaningful output to ./artifact/. These files ARE shown to the user. Prefer a single self-contained HTML file (inline all CSS, JS, fonts, images as data URLs; no external links or CDN references) for reports and visualizations. The file must render correctly when opened directly from disk with no network access. 4. Execute the assignment, then exit.";

/**
 * Throws when `s` is not safe to pass through `cmd.exe /c …` as a
 * single argv element: must contain no LF, no CR, and only printable
 * ASCII (0x20–0x7E). Exported so a unit test can drive the guard
 * without depending on the production constant's value.
 */
export function assertFramingPromptIsSafe(s: string): void {
  if (s.includes("\n") || s.includes("\r") || /[^\x20-\x7E]/.test(s)) {
    throw new Error("framing prompt must be single-line printable ASCII");
  }
}

// Startup-time invariant: prevents a future maintainer from
// accidentally introducing an unsafe framing prompt by editing the
// constant to span multiple lines or include non-ASCII bytes. Fires
// at module-import time so the failure is loud and the test suite
// catches it on every run.
assertFramingPromptIsSafe(TASK_FRAMING_PROMPT_COPILOT);

/**
 * Render the user-supplied `brief` (+ optional `details`) into the
 * canonical TASK.md byte sequence. Two shapes:
 *
 *   - brief-only: `# <brief>\n` (single line, trailing LF, no body)
 *   - brief + details: `# <brief>\n\n<details>\n` (header, blank
 *     separator line, body, trailing LF)
 *
 * `details === undefined` and `details === ""` both collapse to the
 * brief-only shape — an empty body is indistinguishable from no body
 * for the agent's purposes, and emitting `# brief\n\n\n` would just
 * leave a confusing dangling blank section.
 *
 * UTF-8 / no BOM is the caller's responsibility (the manager passes
 * `{ encoding: "utf8" }` to `writeFile`, which never emits a BOM).
 */
export function formatTaskMd(brief: string, details: string | undefined): string {
  if (details === undefined || details.length === 0) {
    return `# ${brief}\n`;
  }
  // Ensure exactly one trailing LF on the body — without it, editors /
  // diff tools complain about "no newline at end of file" and an
  // agent's downstream `read TASK.md` paths see a slightly different
  // byte count between brief-only and brief+details cases.
  const trimmed = details.endsWith("\n") ? details : `${details}\n`;
  return `# ${brief}\n\n${trimmed}`;
}
