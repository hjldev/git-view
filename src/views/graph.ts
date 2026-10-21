import type { Commit } from '../../shared/types';

/** y positions inside a row: 0 = top edge, 1 = node center, 2 = bottom edge. */
export interface GraphEdge {
  x1: number;
  y1: 0 | 1 | 2;
  x2: number;
  y2: 0 | 1 | 2;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  edges: GraphEdge[];
  width: number;
}

export const GRAPH_COLORS = 10;

/**
 * Assigns every commit to a lane and computes the line segments that pass
 * through each row. Commits must be in topological order (children first).
 */
export function layoutGraph(commits: Commit[], flat: boolean): GraphRow[] {
  if (flat) return commits.map(() => ({ lane: 0, color: 0, edges: [], width: 1 }));

  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const alloc = (hash: string): number => {
    let i = lanes.indexOf(null);
    if (i < 0) {
      i = lanes.length;
      lanes.push(null);
    }
    lanes[i] = hash;
    laneColor[i] = nextColor++ % GRAPH_COLORS;
    return i;
  };

  for (const c of commits) {
    const edges: GraphEdge[] = [];
    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) incoming.push(i);
    const lane = incoming.length ? incoming[0] : alloc(c.hash);
    const color = laneColor[lane];

    for (let i = 0; i < lanes.length; i++) {
      const h = lanes[i];
      if (h === null) continue;
      if (h === c.hash) {
        if (incoming.includes(i)) edges.push({ x1: i, y1: 0, x2: lane, y2: 1, color: laneColor[i] });
      } else {
        edges.push({ x1: i, y1: 0, x2: i, y2: 2, color: laneColor[i] });
      }
    }
    for (const i of incoming) if (i !== lane) lanes[i] = null;

    const ps = c.parents;
    if (ps.length === 0) {
      lanes[lane] = null;
    } else {
      const existing = lanes.indexOf(ps[0]);
      if (existing >= 0 && existing !== lane) {
        // The first parent is already drawn in another lane: join it.
        edges.push({ x1: lane, y1: 1, x2: existing, y2: 2, color });
        lanes[lane] = null;
      } else {
        lanes[lane] = ps[0];
        edges.push({ x1: lane, y1: 1, x2: lane, y2: 2, color });
      }
      for (const p of ps.slice(1)) {
        let pi = lanes.indexOf(p);
        if (pi < 0) pi = alloc(p);
        edges.push({ x1: lane, y1: 1, x2: pi, y2: 2, color: laneColor[pi] });
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    let width = lane + 1;
    for (const e of edges) width = Math.max(width, e.x1 + 1, e.x2 + 1);
    rows.push({ lane, color, edges, width });
  }
  return rows;
}
