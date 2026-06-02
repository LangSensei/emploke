import type { AgentEntry } from "@emploke/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Modal } from "../Modal";

export interface CreateModalProps {
  open: boolean;
  agents: AgentEntry[];
  runtimes: string[];
  /** Display name of the active workspace, used in the "where will it land" hint. */
  workspaceDisplayName: string | null;
  /** Native path separator on the server's OS (e.g. `\\` on Windows). */
  pathSeparator: string;
  busy: boolean;
  /**
   * Agent FQN to pre-select when the modal opens. When set and present in
   * `agents`, it wins over the `agents[0]?.agent.fqn` fallback. When set
   * but NOT in `agents` (stale URL / uninstalled agent), the modal
   * silently falls back to `agents[0]` — no error surfaced. This is the
   * cross-page contract from
   * `.pilot/inbox/20260525-agent-detail-deeplinks.md` (modal default-
   * agent rule); the parent page wires its context here (Sessions →
   * `?agent=` filter, AgentDetailPane → currently-selected agent).
   */
  initialAgent?: string;
  onClose: () => void;
  onCreate: (agent: string, runtime: string | undefined) => void;
}

/**
 * Extracted from `pages/Sessions.tsx` (PR #189 polish v3) so the
 * AgentDetailPane can mount the same primitive in place. Behaviour is
 * unchanged for the Sessions page; the new `initialAgent` prop is the
 * only API addition. See {@link CreateModalProps.initialAgent}.
 */
export function CreateModal({
  open,
  agents,
  runtimes,
  workspaceDisplayName,
  pathSeparator,
  busy,
  initialAgent,
  onClose,
  onCreate,
}: CreateModalProps) {
  const [agent, setAgent] = useState<string>("");
  const [runtime, setRuntime] = useState<string>("");

  // Mount-effect resolution order (PR #189 polish v3 — matches
  // DispatchModal exactly so both modals follow the same rule):
  //   1. `initialAgent` wins when present in `agents`.
  //   2. Otherwise fall back to `agents[0]`.
  // Re-runs whenever the modal opens (so re-opening with a new
  // `initialAgent` re-seeds) or when the agents list changes.
  useEffect(() => {
    if (!open) return;
    if (initialAgent && agents.some((a) => a.agent.fqn === initialAgent)) {
      setAgent(initialAgent);
    } else {
      setAgent(agents[0]?.agent.fqn ?? "");
    }
  }, [open, agents, initialAgent]);

  // Default runtime to the first registered kind. If the registry returns
  // an empty list (server unreachable on mount), we leave it blank and
  // submit without a runtime field — the server will pick its default.
  useEffect(() => {
    if (open && runtimes.length > 0 && !runtimes.includes(runtime)) {
      setRuntime(runtimes[0] ?? "");
    }
  }, [open, runtimes, runtime]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agent) return;
    onCreate(agent, runtime || undefined);
  };

  return (
    <Modal open={open} onClose={onClose} title="New session" size="default">
      <form onSubmit={onSubmit}>
        <div className="modal__body">
          <label htmlFor="new-session-agent">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Agent
            </div>
            <select
              id="new-session-agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              disabled={busy}
              required
              className="select select--full"
            >
              {agents.map((a) => (
                <option key={a.agent.fqn} value={a.agent.fqn}>
                  {a.agent.fqn}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="new-session-runtime">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Runtime
            </div>
            <select
              id="new-session-runtime"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
              disabled={busy || runtimes.length === 0}
              className="select select--full"
            >
              {runtimes.length === 0 ? (
                <option value="">(server default)</option>
              ) : (
                runtimes.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))
              )}
            </select>
          </label>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            A new workdir will be created under{" "}
            <code>
              {workspaceDisplayName
                ? `<workspace:${workspaceDisplayName}>${pathSeparator}sessions${pathSeparator}<id>`
                : "<workspace>/sessions/<id>"}
            </code>{" "}
            and the agent will be baked into it.
          </p>
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !agent}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
