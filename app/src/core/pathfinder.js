/**
 * Obstacle-aware path planning on a NavGrid.
 *
 *   1. A* over 8-connected cells whose clearance fits the walker's radius.
 *      Step cost = distance × (1 + penalty near obstacles) so routes prefer the
 *      middle of a passage, the way people walk, instead of scraping furniture.
 *   2. String pulling — collapse the staircase of grid steps into the fewest
 *      straight segments that keep the walker's whole body clear.
 *   3. Corner rounding — Chaikin smoothing, accepted only where it stays clear.
 *
 * Every point of the returned polyline is guaranteed to satisfy
 * `grid.isFree(x, z, radius)`; the tests assert it.
 */
import { MinHeap } from './heap.js';

export const WALKER = Object.freeze({
  standard: { radius: 0.22, comfort: 0.5, speed: 1.3, label: 'Standard' },
  accessible: { radius: 0.38, comfort: 0.7, speed: 0.9, label: 'Step-free / wheelchair' },
});

const SQRT2 = Math.SQRT2;
const NEIGHBOURS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];

function traversal(grid, { radius, comfort, crowdWeight = 1.5 }) {
  const passable = new Uint8Array(grid.walkable.length);
  const penalty = new Float32Array(grid.walkable.length);
  for (let k = 0; k < passable.length; k++) {
    const c = grid.clearance[k];
    if (!grid.walkable[k] || c < radius) continue;
    passable[k] = 1;
    const tight = Math.max(0, (comfort - c) / Math.max(1e-6, comfort - radius));
    penalty[k] = crowdWeight * tight * tight;
  }
  return { passable, penalty };
}

/** Walking distance (m) from a point to every reachable cell (Dijkstra). Infinity = unreachable. */
export function distanceField(grid, from, walker = WALKER.standard) {
  const { width: w } = grid;
  const { passable } = traversal(grid, walker);
  const dist = new Float32Array(passable.length).fill(Infinity);
  const start = grid.nearestFree(from[0], from[1], walker.radius, 3);
  if (!start) return dist;
  const [si, sj] = grid.cellOf(start[0], start[1]);
  const heap = new MinHeap(dist);
  dist[sj * w + si] = 0;
  heap.push(sj * w + si);
  const done = new Uint8Array(passable.length);
  while (heap.size) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    const ci = cur % w, cj = (cur - ci) / w;
    for (const [di, dj, len] of NEIGHBOURS) {
      const ni = ci + di, nj = cj + dj;
      if (!grid.inBounds(ni, nj)) continue;
      const nk = nj * w + ni;
      if (!passable[nk] || done[nk]) continue;
      if (di && dj && !(passable[cj * w + ni] && passable[nj * w + ci])) continue;
      const nd = dist[cur] + len * grid.res;
      if (nd < dist[nk]) { dist[nk] = nd; heap.push(nk); }
    }
  }
  return dist;
}

function astar(grid, start, goal, walker) {
  const { width: w, res } = grid;
  const { passable, penalty } = traversal(grid, walker);
  const [si, sj] = grid.cellOf(start[0], start[1]);
  const [gi, gj] = grid.cellOf(goal[0], goal[1]);
  const startK = sj * w + si, goalK = gj * w + gi;
  const g = new Float32Array(passable.length).fill(Infinity);
  const f = new Float32Array(passable.length).fill(Infinity);
  const parent = new Int32Array(passable.length).fill(-1);
  const closed = new Uint8Array(passable.length);
  const heap = new MinHeap(f);
  const heuristic = (i, j) => {
    const dx = Math.abs(i - gi), dz = Math.abs(j - gj);
    return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * res; // octile: admissible
  };
  g[startK] = 0;
  f[startK] = heuristic(si, sj);
  heap.push(startK);
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === goalK) break;
    const ci = cur % w, cj = (cur - ci) / w;
    for (const [di, dj, len] of NEIGHBOURS) {
      const ni = ci + di, nj = cj + dj;
      if (!grid.inBounds(ni, nj)) continue;
      const nk = nj * w + ni;
      if (!passable[nk] || closed[nk]) continue;
      if (di && dj && !(passable[cj * w + ni] && passable[nj * w + ci])) continue; // no corner cutting
      const ng = g[cur] + len * res * (1 + 0.5 * (penalty[cur] + penalty[nk]));
      if (ng < g[nk]) {
        g[nk] = ng;
        f[nk] = ng + heuristic(ni, nj);
        parent[nk] = cur;
        heap.push(nk);
      }
    }
  }
  if (!closed[goalK]) return null;
  const cells = [];
  for (let k = goalK; k !== -1; k = parent[k]) cells.push(k);
  cells.reverse();
  return { cells, expanded, cost: g[goalK] };
}

/** Greedy any-angle shortcutting that preserves the walker's clearance. */
function pullString(grid, pts, radius) {
  const out = [pts[0]];
  let anchor = 0;
  while (anchor < pts.length - 1) {
    let next = anchor + 1;
    for (let probe = pts.length - 1; probe > anchor + 1; probe--) {
      if (grid.lineOfSight(pts[anchor][0], pts[anchor][1], pts[probe][0], pts[probe][1], radius)) { next = probe; break; }
    }
    out.push(pts[next]);
    anchor = next;
  }
  return out;
}

function roundCorners(grid, pts, radius, iterations = 2) {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) break;
    const next = [cur[0]];
    for (let k = 1; k < cur.length - 1; k++) {
      const [a, b, c] = [cur[k - 1], cur[k], cur[k + 1]];
      const cut = Math.min(0.25, 0.6 / Math.max(0.01, Math.hypot(b[0] - a[0], b[1] - a[1])), 0.6 / Math.max(0.01, Math.hypot(c[0] - b[0], c[1] - b[1])));
      const p = [b[0] + (a[0] - b[0]) * cut, b[1] + (a[1] - b[1]) * cut];
      const q = [b[0] + (c[0] - b[0]) * cut, b[1] + (c[1] - b[1]) * cut];
      if (grid.lineOfSight(p[0], p[1], q[0], q[1], radius)) next.push(p, q);
      else next.push(b);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

export function polylineLength(pts) {
  let total = 0;
  for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return total;
}

/**
 * Plan a walkable route between two world positions (x, z).
 * Start and goal are snapped to the nearest place the walker fits, so a
 * destination *inside* a piece of furniture resolves to standing next to it.
 *
 * @returns {null | {points: [number, number][], length: number, duration: number,
 *   minClearance: number, expanded: number, ms: number, start: [number, number], goal: [number, number]}}
 */
export function findPath(grid, from, to, walker = WALKER.standard) {
  const t0 = performance.now();
  const start = grid.nearestFree(from[0], from[1], walker.radius, 3);
  const goal = grid.nearestFree(to[0], to[1], walker.radius, 4);
  if (!start || !goal) return null;
  const result = astar(grid, start, goal, walker);
  if (!result) return null;

  const raw = result.cells.map((k) => grid.centerOf(k % grid.width, Math.floor(k / grid.width)));
  if (grid.lineOfSight(start[0], start[1], raw[0][0], raw[0][1], walker.radius)) raw[0] = start;
  if (grid.lineOfSight(goal[0], goal[1], raw[raw.length - 1][0], raw[raw.length - 1][1], walker.radius)) raw[raw.length - 1] = goal;

  // Prefer a little extra elbow room when shortcutting; fall back to the bare radius in tight spots.
  const roomy = walker.radius + 0.5 * (walker.comfort - walker.radius);
  const roomyOk = raw.every(([x, z]) => grid.clearanceAt(x, z) >= roomy);
  const margin = roomyOk ? roomy : walker.radius;
  const points = roundCorners(grid, pullString(grid, raw, margin), walker.radius);

  let minClearance = Infinity;
  for (let k = 1; k < points.length; k++) {
    const [a, b] = [points[k - 1], points[k]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / grid.res));
    for (let s = 0; s <= n; s++) {
      minClearance = Math.min(minClearance, grid.clearanceAt(a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n));
    }
  }
  const length = polylineLength(points);
  return {
    points, length, duration: length / walker.speed, minClearance,
    expanded: result.expanded, ms: performance.now() - t0, start, goal,
  };
}
