/**
 * Common return shape for every CLI command. Letting the command
 * functions return a typed payload (instead of touching `process.exit`
 * and stdout directly) keeps them straightforwardly testable — vitest
 * asserts on the result without spying on stdio.
 *
 * The CLI bin layer (`./index.ts`) is the single place that does the
 * actual `process.stdout.write` / `process.stderr.write` / exit-code
 * threading.
 */
export interface CommandResult {
  /** POSIX exit code: 0 success; 1 generic; 2 usage; 3 not running; 4 unhealthy / spawn failed. */
  readonly exitCode: number;
  /** Optional payload for stdout (with trailing newline if non-empty). */
  readonly stdout?: string;
  /** Optional payload for stderr (with trailing newline if non-empty). */
  readonly stderr?: string;
}
