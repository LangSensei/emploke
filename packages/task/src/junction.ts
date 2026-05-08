import { symlink } from "node:fs/promises";

/**
 * Create a directory link at `linkPath` pointing at `target`.
 *
 * On Windows this creates a junction (`mklink /J`-equivalent), which is
 * cross-volume safe and does not require Developer Mode or admin rights.
 * On POSIX the `"junction"` type hint is ignored and Node creates a
 * regular symlink instead. Net result: same code path on all platforms,
 * `<linkPath>` behaves like a transparent alias for `<target>`.
 *
 * `target` must exist; on Windows, junction creation against a missing
 * target succeeds at link-create time but resolution fails later, so the
 * caller is expected to have ensured the target directory exists first.
 */
export async function createDirJunction(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, "junction");
}
