/**
 * Per-domain error policy for the workspaces routes.
 *
 * Source of truth for the (class, status) pairs is the pre-refactor
 * `workspaceErrorStatus` in `routes/workspaces.ts`. The
 * `WorkspaceHasLiveTasksError` 409 mapping is hoisted out of the
 * inline branch in `POST /:id/reload` so the policy carries the full
 * surface; the route's catch block now defers to `respondError`
 * everywhere.
 *
 * NOTE on the per-call `defaultStatus` override: pre-refactor
 * `wsErrorJson(c, err, 500)` baked the fallback into the call site
 * (used by read paths + reload), while `wsErrorJson(c, err, 400)` was
 * used by mutate paths. The post-refactor route preserves this by
 * passing `defaultStatus: 500` only on the read / reload sites; all
 * other sites fall back to the policy default of 400.
 */

import { WorkspaceHasLiveTasksError } from "@emploke/core";
import {
  RegistryError,
  WorkspaceError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "@emploke/workspace";
import type { ErrorPolicy } from "../_respond-error.js";

export const workspacesErrorPolicy: ErrorPolicy = {
  name: "workspaces",
  statuses: [
    [WorkspaceNameInvalidError, 400],
    [WorkspaceIdInvalidError, 400],
    [WorkspaceNotRegisteredError, 404],
    [WorkspaceIdConflictError, 409],
    [WorkspacePathConflictError, 409],
    [WorkspaceHasLiveTasksError, 409],
    // RegistryError and WorkspaceError are abstract bases for several
    // of the entries above (RegistryError ⊃ WorkspaceIdConflictError /
    // WorkspaceIdInvalidError / WorkspacePathConflictError /
    // WorkspaceNotRegisteredError; WorkspaceError ⊃ everything in
    // @emploke/workspace). Listed LAST so concrete subclasses match
    // first; the order preserves the pre-refactor mapping where
    // un-subclassed registry / workspace errors fell to 500.
    [RegistryError, 500],
    [WorkspaceError, 500],
  ],
};
