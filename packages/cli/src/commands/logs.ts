/**
 * `emploke logs [-f]` — print the rolling server log under
 * `<EMPLOKE_HOME>/logs/`. Default mode is one-shot cat; `-f` follows the
 * file by polling its size every 250 ms.
 *
 * Rotation handling: `pino-roll` rolls daily into `<basename>.YYYY-MM-DD`
 * suffixed files. When the active file rotates while we're following, we
 * detect a size shrink (or vanish) and re-resolve the latest file.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { logsDir, resolveEmplokeHome } from "@emploke/api";
import { resolveLatestLog } from "../log-paths.js";
import type { CommandResult } from "../result.js";

export interface LogsOpts {
  readonly home?: string;
  /** Tail-follow mode (`-f`). Stops on SIGINT. */
  readonly follow?: boolean;
  /** Test seam: write destination for log content. Defaults to `process.stdout`. */
  readonly out?: NodeJS.WritableStream;
  /** Test seam: poll interval in follow mode. Default 250 ms. */
  readonly pollIntervalMs?: number;
  /** Test seam: hard cap on follow time. When omitted, follow runs until SIGINT. */
  readonly maxFollowMs?: number;
}

export async function logs(opts: LogsOpts = {}): Promise<CommandResult> {
  const env = process.env;
  const home = resolveEmplokeHome(
    opts.home !== undefined ? { ...env, EMPLOKE_HOME: opts.home } : env,
  );
  const out = opts.out ?? process.stdout;
  const intervalMs = opts.pollIntervalMs ?? 250;
  let latest = await resolveLatestLog(logsDir(home));
  if (!latest) {
    return {
      exitCode: 0,
      stderr: `no logs found under ${logsDir(home)}\n`,
    };
  }
  // Initial pre-follow read. Track byte count so the follow loop's
  // watermark starts at the actual EOF the stream observed (not the
  // pre-read stat, which can be stale by the time the read finishes).
  const initialBytes = await pipeFile(latest, 0, out);
  if (!opts.follow) return { exitCode: 0 };

  let lastSize = initialBytes;
  let stopped = false;
  const onSig = () => {
    stopped = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  const followStarted = Date.now();
  try {
    while (!stopped) {
      if (opts.maxFollowMs !== undefined && Date.now() - followStarted >= opts.maxFollowMs) break;
      await delay(intervalMs);
      let st: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        st = await stat(latest);
      } catch {
        // File rotated away or deleted. Re-resolve.
        const next = await resolveLatestLog(logsDir(home));
        if (next && next !== latest) {
          latest = next;
          const bytes = await pipeFile(latest, 0, out);
          lastSize = bytes;
        }
        continue;
      }
      if (st.size > lastSize) {
        // Advance `lastSize` by the actual byte count piped, not by the
        // pre-read `st.size`: the file can grow further between `stat`
        // and EOF, and using the pre-read size would re-emit those new
        // bytes on the next poll cycle (duplicate lines).
        const bytes = await pipeFile(latest, lastSize, out);
        lastSize += bytes;
      } else if (st.size < lastSize) {
        // Truncated in place: re-tail from start.
        const bytes = await pipeFile(latest, 0, out);
        lastSize = bytes;
      }
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
  return { exitCode: 0 };
}

/**
 * Stream `file` from byte offset `start` to EOF (at the time the stream
 * resolves). Returns the number of bytes consumed so the caller can
 * advance its watermark by the exact amount, avoiding duplicate emits
 * if the file grew further during the read.
 */
function pipeFile(file: string, start: number, out: NodeJS.WritableStream): Promise<number> {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(file, { start, encoding: "utf8" });
    let bytes = 0;
    rs.on("error", reject);
    rs.on("end", () => resolve(bytes));
    rs.on("data", (chunk: string | Buffer) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
      out.write(chunk);
    });
  });
}
