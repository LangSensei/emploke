import { type Application, type ApplicationOptions, composeApplication } from "@emploke/core";

/**
 * Build the server-process composition root.
 *
 * Post de-DDD + core extraction: orchestration is owned by
 * `@emploke/core`. The server is a thin wrapper that adds HTTP
 * routing on top.
 */
export type ServerComposition = Application;

export async function buildServerContainer(opts: ApplicationOptions): Promise<ServerComposition> {
  return composeApplication(opts);
}
