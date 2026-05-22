import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useEffect, useState } from "react";
import type { TaskRecord } from "../../api";
import { Modal } from "../Modal";

export interface DispatchModalProps {
  open: boolean;
  agents: AgentEntry[];
  runtimes: string[];
  busy: boolean;
  /** Pre-fill values from a previous task ("re-run"). null = blank form. */
  prefill: TaskRecord | null;
  onClose: () => void;
  onDispatch: (
    agent: string,
    brief: string,
    details: string | undefined,
    runtime: string | undefined,
  ) => void;
}

const BRIEF_MAX_LENGTH = 200;

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
  const [brief, setBrief] = useState("");
  const [details, setDetails] = useState("");

  useEffect(() => {
    if (!open) return;
    if (prefill) {
      setAgent(prefill.agent);
      const prefRuntime =
        typeof prefill.metadata?.runtime === "string"
          ? (prefill.metadata.runtime as string)
          : (runtimes[0] ?? "");
      setRuntime(prefRuntime);
      setBrief(prefill.brief);
      setDetails(prefill.details ?? "");
    } else {
      setAgent(agents[0]?.agent.fqn ?? "");
      setRuntime(runtimes[0] ?? "");
      setBrief("");
      setDetails("");
    }
  }, [open, agents, runtimes, prefill]);

  const briefTrimmed = brief.trim();
  const briefValid =
    briefTrimmed.length > 0 &&
    briefTrimmed.length <= BRIEF_MAX_LENGTH &&
    !briefTrimmed.includes("\n") &&
    !briefTrimmed.includes("\r");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agent || !briefValid) return;
    const detailsTrimmed = details.trim();
    onDispatch(
      agent,
      briefTrimmed,
      detailsTrimmed.length > 0 ? details : undefined,
      runtime || undefined,
    );
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
          {prefill && prefill.status === "running" && (
            <div className="alert alert--info" style={{ marginBottom: 10 }}>
              Source task is still running. This will dispatch a new task; the source will keep
              running.
            </div>
          )}
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
          <label htmlFor="task-brief">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Brief
            </div>
            <input
              id="task-brief"
              className="input"
              type="text"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Single-line task title (≤ 200 chars)"
              maxLength={BRIEF_MAX_LENGTH}
              required
              disabled={busy}
              style={{ width: "100%", fontFamily: "inherit" }}
            />
          </label>
          <label htmlFor="task-details">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Details (optional)
            </div>
            <textarea
              id="task-details"
              className="input"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Long-form context for the agent (optional, multi-line)"
              rows={8}
              disabled={busy}
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
            disabled={busy || !agent || !briefValid}
          >
            {busy
              ? prefill
                ? "Running again"
                : "Dispatching…"
              : prefill
                ? "Run again"
                : "Dispatch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
