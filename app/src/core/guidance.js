/**
 * Turn a route polyline into guidance: turn-by-turn steps, live progress along the
 * route (remaining distance, next manoeuvre, off-route detection) and stop ordering
 * for multi-destination trips.
 */

const TURN_MIN_DEG = 28;

function heading(a, b) { return Math.atan2(b[0] - a[0], b[1] - a[1]); }

function signedTurn(h0, h1) {
  let d = h1 - h0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function turnPhrase(deg) {
  const side = deg > 0 ? 'left' : 'right';
  const mag = Math.abs(deg);
  if (mag > 150) return { verb: 'Make a U-turn', icon: 'uturn' };
  if (mag > 100) return { verb: `Turn sharp ${side}`, icon: `sharp-${side}` };
  if (mag > 55) return { verb: `Turn ${side}`, icon: side };
  return { verb: `Bear ${side}`, icon: `slight-${side}` };
}

/**
 * @param {[number, number][]} points  route polyline (x, z)
 * @param {object} [opts]
 * @param {string} [opts.destination]  name used in the final step
 * @param {(x: number, z: number) => string | null} [opts.landmarkAt]  POI name near a turn, if any
 * @returns {{at: number, point: [number, number], text: string, icon: string, turnDeg: number}[]}
 *   `at` is the distance along the route (m) where the step happens.
 */
export function buildSteps(points, { destination = 'your destination', landmarkAt = () => null } = {}) {
  const steps = [{ at: 0, point: points[0], text: `Head towards ${destination}`, icon: 'straight', turnDeg: 0 }];
  // Rounded corners arrive as several small bends; merge bends closer than a stride into one turn.
  let along = 0, pending = null;
  const flush = () => {
    if (pending && Math.abs(pending.deg) >= TURN_MIN_DEG) {
      const { verb, icon } = turnPhrase(pending.deg);
      const landmark = landmarkAt(pending.point[0], pending.point[1]);
      steps.push({ at: pending.at, point: pending.point, text: landmark ? `${verb} at ${landmark}` : verb, icon, turnDeg: pending.deg });
    }
    pending = null;
  };
  for (let k = 1; k < points.length - 1; k++) {
    along += Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]);
    const deg = (signedTurn(heading(points[k - 1], points[k]), heading(points[k], points[k + 1])) * 180) / Math.PI;
    if (pending && along - pending.last <= 0.8) { pending.deg += deg; pending.last = along; }
    else { flush(); pending = { at: along, last: along, point: points[k], deg }; }
  }
  flush();
  const n = points.length;
  along += n > 1 ? Math.hypot(points[n - 1][0] - points[n - 2][0], points[n - 1][1] - points[n - 2][1]) : 0;
  steps.push({ at: along, point: points[n - 1], text: `Arrive at ${destination}`, icon: 'arrive', turnDeg: 0 });
  return steps;
}

/** Closest point on the polyline to (x, z): distance along the route and lateral offset. */
export function projectOnRoute(points, x, z) {
  let best = { along: 0, offset: Infinity, segment: 0, point: points[0] };
  let walked = 0;
  for (let k = 1; k < points.length; k++) {
    const [ax, az] = points[k - 1], [bx, bz] = points[k];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const px = ax + dx * t, pz = az + dz * t;
    const offset = Math.hypot(x - px, z - pz);
    const len = Math.sqrt(len2);
    if (offset < best.offset) best = { along: walked + len * t, offset, segment: k - 1, point: [px, pz] };
    walked += len;
  }
  return best;
}

/** Position and heading at a given distance along the polyline. */
export function pointAlong(points, distance) {
  let walked = 0;
  for (let k = 1; k < points.length; k++) {
    const len = Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]);
    if (walked + len >= distance && len > 0) {
      const t = (distance - walked) / len;
      return {
        point: [points[k - 1][0] + (points[k][0] - points[k - 1][0]) * t, points[k - 1][1] + (points[k][1] - points[k - 1][1]) * t],
        heading: heading(points[k - 1], points[k]),
      };
    }
    walked += len;
  }
  const n = points.length;
  return { point: points[n - 1], heading: n > 1 ? heading(points[n - 2], points[n - 1]) : 0 };
}

/** Live guidance state for a walker at (x, z) following `route`. */
export function progress(route, steps, x, z) {
  const proj = projectOnRoute(route.points, x, z);
  const remaining = Math.max(0, route.length - proj.along);
  const next = steps.find((s) => s.at > proj.along + 0.15) ?? steps[steps.length - 1];
  return {
    along: proj.along, remaining, offRoute: proj.offset,
    fraction: route.length > 0 ? proj.along / route.length : 1,
    next, distanceToNext: Math.max(0, next.at - proj.along),
  };
}

/**
 * Order stops to shorten a multi-destination trip (nearest-neighbour seed + 2-opt).
 * @param {number} count  number of stops
 * @param {(a: number, b: number) => number} cost  walking distance between stops; index −1 is the start
 * @returns {number[]} visiting order
 */
export function orderStops(count, cost) {
  const order = [];
  const left = new Set(Array.from({ length: count }, (_, k) => k));
  let cur = -1;
  while (left.size) {
    let best = null;
    for (const k of left) if (best === null || cost(cur, k) < cost(cur, best)) best = k;
    order.push(best);
    left.delete(best);
    cur = best;
  }
  const tour = (o) => o.reduce((sum, k, idx) => sum + cost(idx ? o[idx - 1] : -1, k), 0);
  for (let improved = true; improved;) {
    improved = false;
    for (let a = 0; a < order.length - 1; a++) {
      for (let b = a + 1; b < order.length; b++) {
        const candidate = [...order.slice(0, a), ...order.slice(a, b + 1).reverse(), ...order.slice(b + 1)];
        if (tour(candidate) + 1e-9 < tour(order)) { order.splice(0, order.length, ...candidate); improved = true; }
      }
    }
  }
  return order;
}
