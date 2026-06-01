/**
 * `catalog` subtree registrar. Three resource families — skills,
 * agents, and MCPs — share the same shape of `list / show / install /
 * update / patch / rm / sync-resolve / sync / ack-prereqs / enable /
 * disable` commands. The flat wiring it replaces was 250+ lines of
 * near-identical Commander chains in `index.ts`; here we declare one
 * spec per kind and iterate.
 *
 * Cross-kind asymmetries:
 *   - MCP has no resolve / patch / ack-prereqs.
 *   - Only agent has enable / disable.
 *   - `show --anchor` is present for skills/agents (with different
 *     filename strings — "SKILL.md" vs "AGENTS.md") but absent for MCPs.
 *   - The ident argument is `<name>` for skills/agents and `<fqn>` for
 *     MCPs (and the impl-side opts field name differs too).
 *
 * The ident-name difference is bridged by per-kind action closures
 * stored in the spec, so the loop body stays uniform (no per-kind
 * branching, no casts). Each closure is a one-liner that adapts a
 * uniform `(ident, ...args)` signature into the kind-specific impl's
 * strict opts shape — see also the W3c brief's note on preferring
 * "sum type or call each by name" over casts.
 *
 * Help-text, option flags, command names, and command-registration
 * ORDER are byte-identical to the pre-refactor `index.ts` (Commander
 * preserves registration order in `--help` output, and the tests as
 * well as downstream scripts depend on it).
 */

import type { Command } from "commander";
import {
  catalogAgentAckPrereqs,
  catalogAgentDisable,
  catalogAgentEnable,
  catalogAgentInstall,
  catalogAgentList,
  catalogAgentPatch,
  catalogAgentResolve,
  catalogAgentRm,
  catalogAgentShow,
  catalogAgentSync,
  catalogAgentSyncResolve,
  catalogAgentUpdate,
  catalogMcpInstall,
  catalogMcpList,
  catalogMcpRm,
  catalogMcpShow,
  catalogMcpSync,
  catalogMcpSyncResolve,
  catalogMcpUpdate,
  catalogOverview,
  catalogSkillAckPrereqs,
  catalogSkillInstall,
  catalogSkillList,
  catalogSkillPatch,
  catalogSkillResolve,
  catalogSkillRm,
  catalogSkillShow,
  catalogSkillSync,
  catalogSkillSyncResolve,
  catalogSkillUpdate,
} from "../commands/catalog.js";
import type { CommandResult } from "../result.js";
import {
  parseWorkspaceFlags,
  pickString,
  type Slot,
  type WorkspaceFlagOpts,
  withWorkspaceFlags,
} from "./_shared.js";

/**
 * Uniform per-action closures. Each entry adapts a kind-specific impl
 * (which uses `name` or `fqn` and slightly different option shapes)
 * into a single uniform call signature, so the loop body below can
 * dispatch without casts or per-kind switches. Optional members map
 * 1:1 to the asymmetries documented at the top of the file.
 */
interface KindImpls {
  readonly list: (opts: WorkspaceFlagOpts) => Promise<CommandResult>;
  readonly resolve?: (origin: string, opts: WorkspaceFlagOpts) => Promise<CommandResult>;
  readonly show: (
    ident: string,
    anchor: boolean | undefined,
    opts: WorkspaceFlagOpts,
  ) => Promise<CommandResult>;
  readonly install: (origin: string, opts: WorkspaceFlagOpts) => Promise<CommandResult>;
  readonly update: (
    ident: string,
    content: string | undefined,
    contentFile: string | undefined,
    opts: WorkspaceFlagOpts,
  ) => Promise<CommandResult>;
  readonly patch?: (
    ident: string,
    metadata: string | undefined,
    metadataFile: string | undefined,
    opts: WorkspaceFlagOpts,
  ) => Promise<CommandResult>;
  readonly rm: (ident: string, opts: WorkspaceFlagOpts) => Promise<CommandResult>;
  readonly syncResolve: (ident: string, opts: WorkspaceFlagOpts) => Promise<CommandResult>;
  readonly sync: (
    ident: string,
    planToken: string,
    opts: WorkspaceFlagOpts,
  ) => Promise<CommandResult>;
  readonly ackPrereqs?: (ident: string, opts: WorkspaceFlagOpts) => Promise<CommandResult>;
  readonly enable?: (ident: string, opts: WorkspaceFlagOpts) => Promise<CommandResult>;
  readonly disable?: (ident: string, opts: WorkspaceFlagOpts) => Promise<CommandResult>;
}

interface KindSpec {
  /** Sub-parent command name (`skill` | `agent` | `mcp`). */
  readonly name: "skill" | "agent" | "mcp";
  /** Description for the sub-parent command (shown under `catalog --help`). */
  readonly parentDesc: string;
  /** Argument placeholder for ident-taking actions (`<name>` or `<fqn>`). */
  readonly identPlaceholder: string;
  /** Help text for the ident argument. */
  readonly identDesc: string;
  /** Help text for the `<origin>` argument of `resolve` (when present). */
  readonly resolveOriginDesc?: string;
  /** Help text for the `<origin>` argument of `install`. */
  readonly installOriginDesc: string;
  /** Filename for the `--anchor` flag description; `undefined` ⇒ no anchor flag. */
  readonly anchorDoc?: string;
  /** Per-action descriptions; optional ones gate registration of that command. */
  readonly descriptions: {
    readonly list: string;
    readonly show: string;
    readonly install: string;
    readonly update: string;
    readonly patch?: string;
    readonly rm: string;
    readonly ackPrereqs?: string;
    readonly enable?: string;
    readonly disable?: string;
  };
  readonly impls: KindImpls;
}

/**
 * Build the `content` / `contentFile` patch fragment used by every
 * `update` impl. Mirrors the original index.ts call site exactly:
 * either property is included only when its CLI flag was set
 * (collapsed by `pickString`'s empty-string semantics).
 */
function contentFragment(
  content: string | undefined,
  contentFile: string | undefined,
): { content?: string; contentFile?: string } {
  const out: { content?: string; contentFile?: string } = {};
  if (content !== undefined) out.content = content;
  if (contentFile !== undefined) out.contentFile = contentFile;
  return out;
}

/**
 * Build the `metadata` / `metadataFile` patch fragment used by every
 * `patch` impl. Same precedence semantics as {@link contentFragment}.
 */
function metadataFragment(
  metadata: string | undefined,
  metadataFile: string | undefined,
): { metadata?: string; metadataFile?: string } {
  const out: { metadata?: string; metadataFile?: string } = {};
  if (metadata !== undefined) out.metadata = metadata;
  if (metadataFile !== undefined) out.metadataFile = metadataFile;
  return out;
}

const KIND_SPECS: readonly KindSpec[] = [
  {
    name: "skill",
    parentDesc: "Skill operations",
    identPlaceholder: "<name>",
    identDesc: "Skill name (FQN)",
    resolveOriginDesc: "Skill origin (path / git / npm)",
    installOriginDesc: "Skill origin",
    anchorDoc: "SKILL.md",
    descriptions: {
      list: "List installed skills",
      show: "Show one skill's entry (or just the anchor with --anchor)",
      install: "Install a skill",
      update: "Replace skill content",
      patch: "Patch skill metadata",
      rm: "Remove a skill",
      ackPrereqs: "Acknowledge a skill's prereqs (lifts the prereqs-ack block)",
    },
    impls: {
      list: (opts) => catalogSkillList(opts),
      resolve: (origin, opts) => catalogSkillResolve({ ...opts, origin }),
      show: (name, anchor, opts) => catalogSkillShow({ ...opts, name, anchor: anchor === true }),
      install: (origin, opts) => catalogSkillInstall({ ...opts, origin }),
      update: (name, content, contentFile, opts) =>
        catalogSkillUpdate({ ...opts, name, ...contentFragment(content, contentFile) }),
      patch: (name, metadata, metadataFile, opts) =>
        catalogSkillPatch({ ...opts, name, ...metadataFragment(metadata, metadataFile) }),
      rm: (name, opts) => catalogSkillRm({ ...opts, name }),
      syncResolve: (name, opts) => catalogSkillSyncResolve({ ...opts, name }),
      sync: (name, planToken, opts) => catalogSkillSync({ ...opts, name, planToken }),
      ackPrereqs: (name, opts) => catalogSkillAckPrereqs({ ...opts, name }),
    },
  },
  {
    name: "agent",
    parentDesc: "Agent operations",
    identPlaceholder: "<name>",
    identDesc: "Agent name (FQN)",
    resolveOriginDesc: "Agent origin",
    installOriginDesc: "Agent origin",
    anchorDoc: "AGENTS.md",
    descriptions: {
      list: "List installed agents",
      show: "Show one agent's entry (or just the anchor with --anchor)",
      install: "Install an agent",
      update: "Replace agent content",
      patch: "Patch agent metadata",
      rm: "Remove an agent",
      ackPrereqs: "Acknowledge an agent's prereqs (lifts the prereqs-ack block)",
      enable: "Re-enable a disabled agent",
      disable: "Disable an agent (new dispatches fail with EntryNotReadyError)",
    },
    impls: {
      list: (opts) => catalogAgentList(opts),
      resolve: (origin, opts) => catalogAgentResolve({ ...opts, origin }),
      show: (name, anchor, opts) => catalogAgentShow({ ...opts, name, anchor: anchor === true }),
      install: (origin, opts) => catalogAgentInstall({ ...opts, origin }),
      update: (name, content, contentFile, opts) =>
        catalogAgentUpdate({ ...opts, name, ...contentFragment(content, contentFile) }),
      patch: (name, metadata, metadataFile, opts) =>
        catalogAgentPatch({ ...opts, name, ...metadataFragment(metadata, metadataFile) }),
      rm: (name, opts) => catalogAgentRm({ ...opts, name }),
      syncResolve: (name, opts) => catalogAgentSyncResolve({ ...opts, name }),
      sync: (name, planToken, opts) => catalogAgentSync({ ...opts, name, planToken }),
      ackPrereqs: (name, opts) => catalogAgentAckPrereqs({ ...opts, name }),
      enable: (name, opts) => catalogAgentEnable({ ...opts, name }),
      disable: (name, opts) => catalogAgentDisable({ ...opts, name }),
    },
  },
  {
    name: "mcp",
    parentDesc: "MCP operations",
    identPlaceholder: "<fqn>",
    identDesc: "MCP FQN (<namespace>/<short>)",
    installOriginDesc: "MCP origin",
    descriptions: {
      list: "List installed MCPs",
      show: "Show one MCP's content",
      install: "Install an MCP (fqn is derived from the JSON's `_meta.name`)",
      update: "Replace MCP JSON content",
      rm: "Remove an MCP",
    },
    impls: {
      list: (opts) => catalogMcpList(opts),
      show: (fqn, _anchor, opts) => catalogMcpShow({ ...opts, fqn }),
      install: (origin, opts) => catalogMcpInstall({ ...opts, origin }),
      update: (fqn, content, contentFile, opts) =>
        catalogMcpUpdate({ ...opts, fqn, ...contentFragment(content, contentFile) }),
      rm: (fqn, opts) => catalogMcpRm({ ...opts, fqn }),
      syncResolve: (fqn, opts) => catalogMcpSyncResolve({ ...opts, fqn }),
      sync: (fqn, planToken, opts) => catalogMcpSync({ ...opts, fqn, planToken }),
    },
  },
];

/**
 * Register `emploke catalog …` under the given top-level program.
 * Always registers `catalog overview` plus one sub-parent per
 * {@link KIND_SPECS} entry. Within each kind, commands are registered
 * in a fixed order matching the original flat wiring (Commander uses
 * registration order for `--help` output, so this is part of the
 * user-visible contract).
 */
export function registerCatalogCommands(program: Command, slot: Slot): void {
  const catalogCmd = program
    .command("catalog")
    .description("Catalog operations (workspace-scoped)");

  withWorkspaceFlags(catalogCmd.command("overview"))
    .description("Per-workspace catalog counts")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await catalogOverview(parseWorkspaceFlags(opts));
    });

  for (const spec of KIND_SPECS) {
    const sub = catalogCmd.command(spec.name).description(spec.parentDesc);

    withWorkspaceFlags(sub.command("list"))
      .description(spec.descriptions.list)
      .action(async (opts: Record<string, unknown>) => {
        slot.result = await spec.impls.list(parseWorkspaceFlags(opts));
      });

    if (spec.impls.resolve && spec.resolveOriginDesc !== undefined) {
      const resolve = spec.impls.resolve;
      withWorkspaceFlags(sub.command("resolve"))
        .argument("<origin>", spec.resolveOriginDesc)
        .description("Preview an install plan")
        .action(async (origin: string, opts: Record<string, unknown>) => {
          slot.result = await resolve(origin, parseWorkspaceFlags(opts));
        });
    }

    {
      const showCmd = withWorkspaceFlags(sub.command("show"))
        .argument(spec.identPlaceholder, spec.identDesc)
        .description(spec.descriptions.show);
      if (spec.anchorDoc !== undefined) {
        showCmd.option(
          "--anchor",
          `Fetch only the ${spec.anchorDoc} anchor bytes via the dedicated endpoint`,
        );
      }
      const hasAnchor = spec.anchorDoc !== undefined;
      showCmd.action(async (ident: string, opts: Record<string, unknown>) => {
        const anchor = hasAnchor ? opts.anchor === true : undefined;
        slot.result = await spec.impls.show(ident, anchor, parseWorkspaceFlags(opts));
      });
    }

    withWorkspaceFlags(sub.command("install"))
      .argument("<origin>", spec.installOriginDesc)
      .description(spec.descriptions.install)
      .action(async (origin: string, opts: Record<string, unknown>) => {
        slot.result = await spec.impls.install(origin, parseWorkspaceFlags(opts));
      });

    withWorkspaceFlags(sub.command("update"))
      .argument(spec.identPlaceholder, spec.identDesc)
      .description(spec.descriptions.update)
      .option("--content <text>", "Inline content")
      .option("--content-file <path>", "Read content from file")
      .action(async (ident: string, opts: Record<string, unknown>) => {
        slot.result = await spec.impls.update(
          ident,
          pickString(opts, "content"),
          pickString(opts, "contentFile"),
          parseWorkspaceFlags(opts),
        );
      });

    if (spec.impls.patch && spec.descriptions.patch !== undefined) {
      const patch = spec.impls.patch;
      withWorkspaceFlags(sub.command("patch"))
        .argument(spec.identPlaceholder, spec.identDesc)
        .description(spec.descriptions.patch)
        .option("--metadata <json>", "Inline JSON object")
        .option("--metadata-file <path>", "Read JSON object from file")
        .action(async (ident: string, opts: Record<string, unknown>) => {
          slot.result = await patch(
            ident,
            pickString(opts, "metadata"),
            pickString(opts, "metadataFile"),
            parseWorkspaceFlags(opts),
          );
        });
    }

    withWorkspaceFlags(sub.command("rm"))
      .argument(spec.identPlaceholder, spec.identDesc)
      .description(spec.descriptions.rm)
      .action(async (ident: string, opts: Record<string, unknown>) => {
        slot.result = await spec.impls.rm(ident, parseWorkspaceFlags(opts));
      });

    withWorkspaceFlags(sub.command("sync-resolve"))
      .argument(spec.identPlaceholder, spec.identDesc)
      .description("Preview a re-sync plan against the upstream origin")
      .action(async (ident: string, opts: Record<string, unknown>) => {
        slot.result = await spec.impls.syncResolve(ident, parseWorkspaceFlags(opts));
      });

    withWorkspaceFlags(sub.command("sync"))
      .argument(spec.identPlaceholder, spec.identDesc)
      .requiredOption("--plan-token <token>", `planToken from \`${spec.name} sync-resolve\``)
      .description("Apply a previously-previewed sync plan")
      .action(async (ident: string, opts: Record<string, unknown>) => {
        slot.result = await spec.impls.sync(
          ident,
          pickString(opts, "planToken") ?? "",
          parseWorkspaceFlags(opts),
        );
      });

    if (spec.impls.ackPrereqs && spec.descriptions.ackPrereqs !== undefined) {
      const ackPrereqs = spec.impls.ackPrereqs;
      withWorkspaceFlags(sub.command("ack-prereqs"))
        .argument(spec.identPlaceholder, spec.identDesc)
        .description(spec.descriptions.ackPrereqs)
        .action(async (ident: string, opts: Record<string, unknown>) => {
          slot.result = await ackPrereqs(ident, parseWorkspaceFlags(opts));
        });
    }

    if (spec.impls.enable && spec.descriptions.enable !== undefined) {
      const enable = spec.impls.enable;
      withWorkspaceFlags(sub.command("enable"))
        .argument(spec.identPlaceholder, spec.identDesc)
        .description(spec.descriptions.enable)
        .action(async (ident: string, opts: Record<string, unknown>) => {
          slot.result = await enable(ident, parseWorkspaceFlags(opts));
        });
    }
    if (spec.impls.disable && spec.descriptions.disable !== undefined) {
      const disable = spec.impls.disable;
      withWorkspaceFlags(sub.command("disable"))
        .argument(spec.identPlaceholder, spec.identDesc)
        .description(spec.descriptions.disable)
        .action(async (ident: string, opts: Record<string, unknown>) => {
          slot.result = await disable(ident, parseWorkspaceFlags(opts));
        });
    }
  }
}
