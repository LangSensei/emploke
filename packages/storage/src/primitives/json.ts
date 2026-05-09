import { open, stat } from "node:fs/promises";

/**
 * Hard cap on metadata-file size. Catalog/workspace/session/task JSONs
 * are tiny (< 4 KB typical). Anything bigger is almost certainly an
 * accident or an attack — refuse to read it into memory rather than
 * letting a malformed gigabyte-scale `workspace.json` OOM the process.
 *
 * Callers that legitimately need to read a larger blob can override
 * via `readJson(path, { maxBytes })`.
 */
export const DEFAULT_READ_JSON_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** Thrown when a file rejected by the size cap exists. */
export class JsonFileTooLargeError extends Error {
  constructor(
    public readonly path: string,
    public readonly sizeBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`refusing to read ${path}: ${sizeBytes} bytes exceeds cap of ${maxBytes}`);
    this.name = "JsonFileTooLargeError";
  }
}

export interface ReadJsonOpts {
  /** Maximum file size to read. Default {@link DEFAULT_READ_JSON_MAX_BYTES}. */
  readonly maxBytes?: number;
}

/**
 * Read + parse JSON. Returns `null` if the file is missing.
 * Throws on parse failure (caller decides how to surface).
 * Throws {@link JsonFileTooLargeError} if the file exceeds the size cap.
 *
 * Deliberately does NOT do schema validation — that is a Repository
 * concern. This primitive is "raw bytes -> any". Callers wrap it with
 * their entity-specific validation (typically per-package schema check
 * + typed Corrupted* error).
 */
export async function readJson<T = unknown>(
  absPath: string,
  opts: ReadJsonOpts = {},
): Promise<T | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_READ_JSON_MAX_BYTES;
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (st.size > maxBytes) throw new JsonFileTooLargeError(absPath, st.size, maxBytes);

  // Use a file handle so we honor the size we observed under the same
  // open(). Reading via readFile() afterwards would re-stat and could
  // race a concurrent writer growing the file past the cap.
  const fh = await open(absPath, "r");
  let buf: string;
  try {
    buf = await fh.readFile({ encoding: "utf8" });
  } finally {
    await fh.close();
  }
  // Defense-in-depth: stat-then-open is a TOCTOU race — a concurrent
  // writer can grow the file between stat() and readFile(). The pre-read
  // stat is still useful (avoids materializing genuinely huge files at
  // all) but the byte-count guard belongs after the read too.
  if (buf.length > maxBytes) {
    throw new JsonFileTooLargeError(absPath, buf.length, maxBytes);
  }
  return JSON.parse(buf) as T;
}
