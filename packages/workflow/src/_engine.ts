/**
 * `WorkflowEngine` — the in-memory, event-driven tick loop that
 * advances workflows by dispatching ready nodes to per-kind
 * `WorkflowNodeRunner` implementations.
 *
 * # Why no timer?
 *
 * Per spec #325 D3 + the M1 brief: this module MUST NOT contain
 * `setInterval` or `setTimeout`. All polling lives inside concrete
 * runner implementations (e.g. `workflow-task-runner.ts` polls
 * `tasks.get(...)` to discover terminal status). The engine reacts
 * to two events only:
 *
 *   1. The substrate calls {@link WorkflowEngine.triggerWorkflowTick}
 *      after every mutation tx commits (createWorkflow, addNode,
 *      addEdge, addSubgraph, cancelNode, finishWorkflow,
 *      cancelWorkflow, removeNode, removeEdge, replaceNodeSpec, and
 *      `markNodeTerminal` itself).
 *   2. A runner pushes a terminal outcome back via the `onTerminal`
 *      callback the engine handed it at `dispatch` time; the engine
 *      writes the terminal status via `service.markNodeTerminal`,
 *      which in turn fires (1) again. This is the "ratchet" that
 *      drives a workflow forward.
 *
 * A central interval timer would either tick too fast (wasted DB
 * reads) or too slow (stale state) and would defeat the per-runner
 * polling cadence. By staying purely event-driven, the engine is
 * latency-optimal under the legal-cancellation pattern (Phase 2b)
 * and the cost of a workflow that's "doing nothing" is exactly
 * zero CPU.
 *
 * The acceptance gate is enforced by `engine-no-timer.test.ts`,
 * which greps this file's source for `setInterval` / `setTimeout`.
 *
 * # Per-workflow serialization
 *
 * Two concurrent triggers on the same workflow could otherwise race
 * `dispatchAtomic` calls + their state-transition writes. The engine
 * serializes per workflow id via a `Map<workflowId, Promise<void>>`
 * chain: each `triggerWorkflowTick` reads the current tail, chains
 * `tickOnce` onto it, and writes the new tail back. The Map is
 * pruned on settle (using `next.finally(...)`) so it does NOT grow
 * with the cumulative count of ever-touched workflows.
 *
 * Cross-workflow ticks run in parallel (each workflow has its own
 * chain), and within a single tick all eligible nodes dispatch in
 * parallel via `Promise.all`.
 *
 * # Engine ↔ service cycle
 *
 * The engine calls into `WorkflowService.dispatchAtomic` and
 * `WorkflowService.markNodeTerminal`. The service calls into
 * `WorkflowEngine.triggerWorkflowTick`. `compose.ts` resolves the
 * cycle with two-phase init: construct the service with no engine,
 * construct the engine with the service, then `service.setEngine(e)`.
 *
 * # State
 *
 * Pure in-memory: a `Map<workflowId, Promise>` chain + a
 * `shuttingDown` flag + the injected deps. No tables, no module-
 * level mutables, no persistence — engine restart = in-flight nodes
 * stuck `running` until a Phase 3 recovery story lands (out of scope
 * per the M1 brief).
 */

import type { Logger } from "pino";
import pino from "pino";
import type { WorkflowNodeTerminalResult } from "./types.js";
import type { WorkflowService } from "./workflow-service.js";

const silentLogger: Logger = pino({ level: "silent" });

export interface WorkflowEngineDeps {
  readonly service: WorkflowService;
  readonly logger?: Logger;
}

export class WorkflowEngine {
  private readonly service: WorkflowService;
  private readonly logger: Logger;
  private readonly perWorkflowChain = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(deps: WorkflowEngineDeps) {
    this.service = deps.service;
    this.logger = deps.logger ?? silentLogger;
  }

  /**
   * Lifecycle hook called by `compose.ts` after construction.
   *
   * M1 is a no-op: there are no timers to launch and no recovery
   * scan to run (engine restart recovery is out-of-scope per the
   * brief; in-flight nodes from a previous process are stuck
   * `running` until Phase 3 ships the recovery hook). Present as a
   * named method so compose stays symmetrical with `stop()` and so
   * future milestones have a place to plug recovery in without
   * changing the boot contract.
   */
  start(): void {
    this.logger.debug("WorkflowEngine.start: no-op in M1");
  }

  /**
   * Graceful shutdown. Flips `shuttingDown` (so further
   * `triggerWorkflowTick` calls are no-ops) then awaits every
   * in-flight per-workflow tick chain. Idempotent — repeated calls
   * after the first await the same set of (already-settled)
   * promises and return immediately.
   *
   * Note: this does NOT cancel in-flight runner dispatches. A
   * `runner.dispatch` that's mid-poll continues to its natural
   * conclusion; runner-side dispose (e.g. the worker runner's
   * `dispose()` clearing its interval Map) is the caller's
   * responsibility and is invoked by the test composition's
   * shutdown step.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    const inflight = Array.from(this.perWorkflowChain.values());
    if (inflight.length === 0) return;
    await Promise.allSettled(inflight);
  }

  /**
   * Schedule a tick on `workflowId`. Returns synchronously after
   * appending to that workflow's chain. The actual tick body runs
   * after the current event-loop turn (Promise microtask) so the
   * caller's tx-commit code path returns promptly.
   *
   * Per-workflow serialization: the new tick chains off the
   * workflow's current tail (or a resolved Promise if none) so two
   * back-to-back triggers always observe the previous tick's
   * state-writes before reading.
   *
   * Map prune on settle: when the new tail settles, if it's still
   * the entry in the Map (i.e. no later trigger has overwritten),
   * the Map entry is deleted. This keeps the Map's size bounded by
   * the number of *concurrently-active* workflows rather than the
   * cumulative count of ever-touched workflows.
   */
  triggerWorkflowTick(workflowId: string): void {
    if (this.shuttingDown) return;
    const prev = this.perWorkflowChain.get(workflowId) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(() => this.tickOnce(workflowId))
      .catch((err) => {
        this.logger.warn(
          { workflowId, err },
          "WorkflowEngine.triggerWorkflowTick: tickOnce threw; swallowed",
        );
      });
    this.perWorkflowChain.set(workflowId, next);
    void next.finally(() => {
      if (this.perWorkflowChain.get(workflowId) === next) {
        this.perWorkflowChain.delete(workflowId);
      }
    });
  }

  /**
   * One tick of `workflowId`: snapshot eligible node ids, then for
   * each id call `service.dispatchAtomic(id, onTerminal)` in
   * parallel. The substrate's `dispatchAtomic` re-checks every
   * eligibility gate inside its own write tx — a node that became
   * ineligible between our snapshot and the tx is silently no-op'd
   * by the substrate.
   *
   * `onTerminal` is closed over `workflowId` + the runner's
   * `nodeId`. On invocation it calls `service.markNodeTerminal`
   * (which is idempotent) and then re-enters
   * `triggerWorkflowTick(workflowId)` so the workflow advances.
   *
   * Skips the entire tick (no-op return) when `shuttingDown` has
   * been flipped between the trigger and this body running.
   */
  private async tickOnce(workflowId: string): Promise<void> {
    if (this.shuttingDown) return;
    let eligible: readonly string[];
    try {
      eligible = await this.service.listEligibleNodeIdsForDispatch(workflowId);
    } catch (err) {
      this.logger.warn(
        { workflowId, err },
        "WorkflowEngine.tickOnce: listEligibleNodeIdsForDispatch threw",
      );
      return;
    }
    if (eligible.length === 0) return;

    await Promise.all(
      eligible.map(async (nodeId) => {
        const onTerminal = (result: WorkflowNodeTerminalResult): void => {
          this.handleRunnerTerminal(workflowId, nodeId, result);
        };
        try {
          await this.service.dispatchAtomic(nodeId, onTerminal);
        } catch (err) {
          // dispatchAtomic already handles runner.dispatch throws
          // internally (marks the node failed via markNodeTerminal).
          // A throw bubbling here would mean the substrate's own tx
          // (the ready→running flip or the post-dispatch failure
          // write) threw, which is genuinely exceptional.
          this.logger.error(
            { workflowId, nodeId, err },
            "WorkflowEngine.tickOnce: dispatchAtomic threw unexpectedly",
          );
        }
      }),
    );
  }

  /**
   * Runner-pushed terminal handler. Fires `markNodeTerminal`
   * (idempotent — runners are explicitly allowed to over-fire) and
   * then re-triggers the workflow's tick so downstream nodes that
   * just became eligible get a chance to dispatch.
   *
   * Best-effort: any error landing the terminal state is logged but
   * NOT propagated, because the caller is a runner's callback and
   * the runner has no useful way to recover. The substrate's
   * `markNodeTerminal` already logs internally; we add a tier of
   * engine-side context so log scans can correlate.
   */
  private handleRunnerTerminal(
    workflowId: string,
    nodeId: string,
    result: WorkflowNodeTerminalResult,
  ): void {
    void this.service.markNodeTerminal(workflowId, nodeId, result).catch((err) => {
      this.logger.error(
        { workflowId, nodeId, result, err },
        "WorkflowEngine.handleRunnerTerminal: markNodeTerminal threw",
      );
    });
    // markNodeTerminal already nudges the engine post-commit. We do
    // NOT trigger again here — that would double-tick and is
    // unnecessary work (the substrate's nudge fires *after* the
    // terminal commit lands, which is the correct ordering).
  }
}
