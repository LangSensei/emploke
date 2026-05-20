import { RequestData } from "mediatr-ts";

/**
 * Command payload: rename an already-registered workspace's display
 * name. The id is the immutable URL routing key; `newName` is the
 * only mutable field on the workspace today.
 *
 * Returns void (the caller can re-query for the updated view).
 */
export class RenameWorkspaceCommand extends RequestData<void> {
  constructor(
    public readonly id: string,
    public readonly newName: string,
  ) {
    super();
  }
}
