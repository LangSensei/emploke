import type { ReactElement } from "react";
import { splitFqnForDisplay } from "../../utils/fqn";

/**
 * Shared `scope/short` two-tone display primitive.
 *
 * Renders the full FQN as a single inline-flex line:
 *
 *   <scope>/<short>
 *      ↑    ↑    ↑
 *      |    |    + semibold (the part users type / search for)
 *      |    + semibold separator (binds the two halves visually)
 *      + normal weight (the scope disambiguates; must stay full-strength
 *        color, never muted, so two agents with the same short name and
 *        different scopes are unambiguously distinguishable on a row)
 *
 * Both halves render at the **same font size and the same foreground
 * colour** (`var(--color-text)`). Visual hierarchy comes from font-weight
 * only — scope normal, separator + short semibold. This is the policy
 * the row-redesign brief locked in (see
 * `.pilot/inbox/20260525-agents-row-redesign.md`); changing it requires
 * updating both the brief and the lock-in tests.
 */

export interface AgentFqnProps {
  /** Full FQN (`scope/short`). */
  fqn: string;
  /**
   * Truncate the scope half with `text-overflow: ellipsis` when the FQN
   * is too wide for its container. Defaults to `true` (the row layout
   * relies on it). The short half NEVER truncates — it's the most
   * scannable token.
   */
  truncateScope?: boolean;
  /** Wrapping tag. Defaults to `<span>` so the primitive composes inside
   *  inline contexts (list cells, mention chips). `"div"` is available
   *  for callers that want block-level positioning. */
  as?: "span" | "div";
}

export function AgentFqn({ fqn, truncateScope = true, as = "span" }: AgentFqnProps): ReactElement {
  const { scope, shortName } = splitFqnForDisplay(fqn);
  const className = `agent-fqn${truncateScope ? " agent-fqn--truncate-scope" : ""}`;
  const Tag = as;
  return (
    <Tag className={className} title={fqn} data-testid={`agent-fqn-${fqn}`}>
      <span className="agent-fqn__scope">{scope}</span>
      <span className="agent-fqn__sep">/</span>
      <span className="agent-fqn__short">{shortName}</span>
    </Tag>
  );
}
