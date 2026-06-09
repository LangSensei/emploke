import type { WorkflowEdgeWire, WorkflowNodeWire } from "../../api";

/**
 * Pure geometry helpers for the vertical (top-to-bottom) DAG layout.
 *
 * The {@link WorkflowDagView} renders nodes as a CSS grid (one row
 * per phase, one column per node within the phase) and overlays an
 * SVG arrow layer driven by the data this module computes. Pulling
 * the layout math out of the React component keeps the render-side
 * declarative and lets the geometry be unit-tested in isolation
 * (vitest can exercise it without React renderering).
 *
 * Coordinates are abstract grid cells, not pixels:
 *
 *   - row    = phase index (smaller = closer to the top)
 *   - column = 0-based position within that phase (left → right)
 *
 * Pixel translation happens in the React layer where the actual
 * grid track sizes are known. A separate `measureNodePositions`
 * helper here turns DOM refs into edge endpoints, but the bulk of
 * the geometry (slot assignment) is grid-only.
 */

export interface NodeSlot {
  readonly nodeId: string;
  /** Phase index (the substrate's `node.phase`). */
  readonly row: number;
  /** 0-based column within the phase, in `createdAt` ascending order. */
  readonly column: number;
}

export interface PhaseRow {
  readonly phase: number;
  readonly nodes: readonly WorkflowNodeWire[];
}

/**
 * Group nodes by `phase` and sort each phase's nodes by `createdAt`
 * ASC. Output is in ascending phase order — the visual top-down
 * stack — and each phase carries a stable column order so re-renders
 * with the same wire input produce the same layout (no flicker on
 * poll).
 */
export function groupByPhase(nodes: readonly WorkflowNodeWire[]): readonly PhaseRow[] {
  const byPhase = new Map<number, WorkflowNodeWire[]>();
  for (const node of nodes) {
    const slot = byPhase.get(node.phase);
    if (slot === undefined) byPhase.set(node.phase, [node]);
    else slot.push(node);
  }
  for (const arr of byPhase.values()) {
    arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return Array.from(byPhase.keys())
    .sort((a, b) => a - b)
    .map((phase) => ({
      phase,
      nodes: byPhase.get(phase) ?? [],
    }));
}

/**
 * Build a lookup map from node id to its grid slot ({row, column})
 * so the SVG overlay can resolve `edge.from` / `edge.to` to their
 * positions without re-walking the phase list per edge.
 */
export function buildSlotMap(phases: readonly PhaseRow[]): ReadonlyMap<string, NodeSlot> {
  const out = new Map<string, NodeSlot>();
  for (const { phase, nodes } of phases) {
    nodes.forEach((node, i) => {
      out.set(node.id, { nodeId: node.id, row: phase, column: i });
    });
  }
  return out;
}

export interface EdgeSegment {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  /** Slot row of the source node (parent phase). */
  readonly fromRow: number;
  /** Slot row of the destination node (child phase). */
  readonly toRow: number;
}

/**
 * Resolve each wire edge to the row indices of its endpoints, dropping
 * edges that reference an unknown node id. The View layer turns the
 * row pair into pixel coordinates by measuring the rendered DOM
 * elements.
 */
export function resolveEdges(
  edges: readonly WorkflowEdgeWire[],
  slots: ReadonlyMap<string, NodeSlot>,
): readonly EdgeSegment[] {
  const out: EdgeSegment[] = [];
  for (const edge of edges) {
    const from = slots.get(edge.from);
    const to = slots.get(edge.to);
    if (from === undefined || to === undefined) continue;
    out.push({
      id: `${edge.from}->${edge.to}`,
      fromNodeId: edge.from,
      toNodeId: edge.to,
      fromRow: from.row,
      toRow: to.row,
    });
  }
  return out;
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface EdgeEndpoints {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  /** Container-relative bottom-centre of the source node. */
  readonly x1: number;
  readonly y1: number;
  /** Container-relative top-centre of the destination node. */
  readonly x2: number;
  readonly y2: number;
}

/**
 * Compute the bottom-centre → top-centre endpoints for each edge,
 * relative to the DAG container. Pure function over plain rects so
 * the React layer can pass the result of `getBoundingClientRect()`
 * calls (offset by the container's own rect) without any further
 * massaging. Edges whose endpoints aren't both measured yet are
 * skipped — the next React render will re-call this once refs land.
 */
export function projectEndpoints(
  segments: readonly EdgeSegment[],
  rects: ReadonlyMap<string, Rect>,
): readonly EdgeEndpoints[] {
  const out: EdgeEndpoints[] = [];
  for (const seg of segments) {
    const a = rects.get(seg.fromNodeId);
    const b = rects.get(seg.toNodeId);
    if (a === undefined || b === undefined) continue;
    out.push({
      id: seg.id,
      fromNodeId: seg.fromNodeId,
      toNodeId: seg.toNodeId,
      x1: a.left + a.width / 2,
      y1: a.top + a.height,
      x2: b.left + b.width / 2,
      y2: b.top,
    });
  }
  return out;
}
