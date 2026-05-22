import { composeEmplokeCore, type EmplokeCore, type EmplokeCoreOptions } from "@emploke/core";

/**
 * Build the server-process composition root.
 *
 * Post de-DDD + core extraction: orchestration is owned by
 * `@emploke/core`. The server is a thin wrapper that adds HTTP
 * routing on top.
 */
export type ServerComposition = EmplokeCore;

export async function buildServerContainer(opts: EmplokeCoreOptions): Promise<ServerComposition> {
  return composeEmplokeCore(opts);
}
