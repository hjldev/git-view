import type { Commit } from '../../shared/types';

/** y positions inside a row: 0 = top edge, 1 = node center, 2 = bottom edge. */
export interface GraphEdge {
  x1: number;
  y1: 0 | 1 | 2;
  x2: number;
  y2: 0 | 1 | 2;
  color: number;
}

/**
 * Stub of a collapsed long edge (IDEA hides edges spanning many rows): a short
 * arrow leaving the child downwards, or arriving at the parent from above.
 */
export interface GraphArrow {
  x: number;
  dir: 'down' | 'up';
  /** Horizontal lean of a down arrow: 0 for the first parent, 1 for merged parents. */
  dx: 0 | 1;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  edges: GraphEdge[];
  arrows: GraphArrow[];
  width: number;
}

export const GRAPH_COLORS = 10;

/**
 * Assigns every commit to a lane and computes the line segments that pass
 * through each row. Commits must be ordered children first. Edges spanning
 * more than `longEdge` rows (or leading to commits that are not loaded) are
 * collapsed into arrows so they do not reserve a lane over their whole length.
 */
export function layoutGraph(commits: Commit[], flat: boolean, longEdge = Infinity): GraphRow[] {
  if (flat) return commits.map(() => ({ lane: 0, color: 0, edges: [], arrows: [], width: 1 }));

  const index = new Map<string, number>();
  commits.forEach((c, i) => index.set(c.hash, i));
  const collapsedTargets = new Set<string>();

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

  commits.forEach((c, row) => {
    const edges: GraphEdge[] = [];
    const arrows: GraphArrow[] = [];
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
    if (collapsedTargets.has(c.hash)) arrows.push({ x: lane, dir: 'up', dx: 0, color });

    let keepLane = false;
    c.parents.forEach((p, k) => {
      const target = index.get(p);
      const span = target === undefined ? Infinity : target - row;
      if (span > longEdge) {
        arrows.push({ x: lane, dir: 'down', dx: k === 0 ? 0 : 1, color });
        if (target !== undefined) collapsedTargets.add(p);
        return;
      }
      if (k === 0) {
        const existing = lanes.indexOf(p);
        if (existing >= 0 && existing !== lane) {
          // The first parent is already drawn in another lane: join it.
          edges.push({ x1: lane, y1: 1, x2: existing, y2: 2, color });
        } else {
          lanes[lane] = p;
          keepLane = true;
          edges.push({ x1: lane, y1: 1, x2: lane, y2: 2, color });
        }
        return;
      }
      let pi = lanes.indexOf(p);
      if (pi < 0) pi = alloc(p);
      edges.push({ x1: lane, y1: 1, x2: pi, y2: 2, color: laneColor[pi] });
    });
    if (!keepLane && lanes[lane] === c.hash) lanes[lane] = null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    let width = lane + 1;
    for (const e of edges) width = Math.max(width, e.x1 + 1, e.x2 + 1);
    for (const a of arrows) width = Math.max(width, a.x + 1 + a.dx);
    rows.push({ lane, color, edges, arrows, width });
  });
  return rows;
}
