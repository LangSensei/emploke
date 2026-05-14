import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useEffect, useState } from "react";
import type { TaskRecord } from "../../api";
import { Modal } from "../../components/Modal";

interface DispatchModalProps {
  open: boolean;
  agents: AgentEntry[];
  runtimes: string[];
  busy: boolean;
  /** Pre-fill values from a previous task ("re-run"). null = blank form. */
  prefill: TaskRecord | null;
  onClose: () => void;
  onDispatch: (agent: string, instructions: string, runtime: string | undefined) => void;
}

export function DispatchModal({
  open,
  agents,
  runtimes,
  busy,
  prefill,
  onClose,
  onDispatch,
}: DispatchModalProps) {
  const [agent, setAgent] = useState<string>("");
  const [runtime, setRuntime] = useState<string>("");
  const [instructions, setInstructions] = useState("");

  // Reset form on open. When `prefill` is set we seed from the source
  // task — useful for re-dispatching a failed task with the same params
  // (or with a small tweak before submitting). Otherwise we start blank
  // with the catalog's first ready agent.
  useEffect(() => {
    if (!open) return;
    if (prefill) {
      setAgent(prefill.agent);
      const prefRuntime =
        typeof prefill.metadata?.runtime === "string"
          ? (prefill.metadata.runtime as string)
          : (runtimes[0] ?? "");
      setRuntime(prefRuntime);
      setInstructions(prefill.instructions);
    } else {
      setAgent(agents[0]?.agent.fqn ?? "");
      setRuntime(runtimes[0] ?? "");
      setInstructions("");
    }
  }, [open, agents, runtimes, prefill]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agent || !instructions.trim()) return;
    onDispatch(agent, instructions.trim(), runtime || undefined);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={prefill ? "Re-run task" : "Dispatch task"}
      size="default"
    >
      <form onSubmit={onSubmit}>
        <div className="modal__body">
          <label htmlFor="task-agent">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Agent
            </div>
            <select
              id="task-agent"
              className="select select--full"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              disabled={busy}
              required
            >
              {agents.map((a) => (
                <option key={a.agent.fqn} value={a.agent.fqn}>
                  {a.agent.fqn}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="task-runtime">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Runtime
            </div>
            <select
              id="task-runtime"
              className="select select--full"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
              disabled={busy || runtimes.length === 0}
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
          <label htmlFor="task-instructions">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Instructions
            </div>
            <textarea
              id="task-instructions"
              className="input"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="What should the agent do?"
              rows={8}
              required
              style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
            />
          </label>
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || !agent || !instructions.trim()}
          >
            {busy ? (prefill ? "Re-running…" : "Dispatching…") : prefill ? "Re-run" : "Dispatch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
