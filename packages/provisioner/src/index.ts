/**
 * @emploke/provisioner — composes a workspace directory for an agent runtime.
 *
 * Provisioners take a fully-resolved dependency manifest (from
 * `@emploke/catalog`) plus a target directory and write files. They do not
 * resolve names, launch processes, or know anything about tasks.
 */

export { CopilotProvisioner, flattenSkillName } from "./copilot.js";
export { InvalidMcpJson, ProvisionError, WorkspacePrepFailed } from "./errors.js";
export type { Provisioner, ProvisionParams } from "./types.js";
