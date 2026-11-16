import test from 'node:test';
import assert from 'node:assert/strict';
import { findPath, distanceField, polylineLength, WALKER } from '../app/src/core/pathfinder.js';
import { gridFromArt, WALLED_ROOM } from './helpers.mjs';

/** Sample every 2 cm of the route and require the walker's body to be clear of obstacles. */
function assertCollisionFree(grid, route, radius) {
  for (let k = 1; k < route.points.length; k++) {
    const [a, b] = [route.points[k - 1], route.points[k]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.02));
    for (let s = 0; s <= n; s++) {
      const x = a[0] + ((b[0] - a[0]) * s) / n, z = a[1] + ((b[1] - a[1]) * s) / n;
      assert.ok(grid.isFree(x, z, radius - 1e-6), `route touches an obstacle at (${x.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }
}

test('routes go around a wall through the doorway and never touch obstacles', () => {
  const { grid, marks } = gridFromArt(WALLED_ROOM, { scale: 6 }); // 0.6 m per character, so a 0.6 m doorway
  const route = findPath(grid, marks.A, marks.B);
  assert.ok(route, 'a route exists');
  assertCollisionFree(grid, route, WALKER.standard.radius);
  const doorway = route.points.some(([x, z]) => Math.abs(x - 9.5 * 0.6) < 0.4 && Math.abs(z - 6.5 * 0.6) < 0.3);
  assert.ok(doorway, 'the route passes through the only doorway');
  const straight = Math.hypot(marks.B[0] - marks.A[0], marks.B[1] - marks.A[1]);
  assert.ok(route.length > straight, 'longer than the blocked straight line');
});

test('route length is near the true shortest walking distance', () => {
  const { grid, marks } = gridFromArt(WALLED_ROOM, { scale: 6 });
  const route = findPath(grid, marks.A, marks.B);
  const field = distanceField(grid, marks.A);
  const [gi, gj] = grid.cellOf(...marks.B);
  const gridOptimal = field[gj * grid.width + gi]; // exact 8-connected shortest path
  // Any-angle smoothing can only shorten a grid path; comfort detours may add a little.
  assert.ok(route.length <= gridOptimal * 1.05, `${route.length} vs grid optimum ${gridOptimal}`);
  assert.ok(route.length >= gridOptimal * 0.85, 'not shorter than physically possible');
});

test('an open room yields a single straight segment', () => {
  const { grid, marks } = gridFromArt(['########', '#A.....#', '#......#', '#.....B#', '########']);
  const route = findPath(grid, marks.A, marks.B);
  assert.equal(route.points.length, 2);
  assert.ok(Math.abs(route.length - Math.hypot(route.goal[0] - route.start[0], route.goal[1] - route.start[1])) < 1e-6);
});

test('unreachable destinations return null instead of a path through walls', () => {
  const { grid, marks } = gridFromArt(['#########', '#A..#..B#', '#...#...#', '#########']);
  assert.equal(findPath(grid, marks.A, marks.B), null);
  const field = distanceField(grid, marks.A);
  const [bi, bj] = grid.cellOf(...marks.B);
  assert.equal(field[bj * grid.width + bi], Infinity);
});

test('a gap narrower than the walker is not used', () => {
  // The doorway is one character = 0.2 m wide here; the detour around is long but valid.
  const rows = ['###########', '#A...#...B#', '#....#....#', '#.........#', '#....#....#', '#....#....#', '###########'];
  const { grid, marks } = gridFromArt(rows, { res: 0.05, scale: 4 });
  assert.equal(findPath(grid, marks.A, marks.B, WALKER.accessible), null, '0.2 m gap is too narrow for a wheelchair');
  assert.equal(findPath(grid, marks.A, marks.B, WALKER.standard), null, '…and for a person');
  const wide = gridFromArt(rows, { res: 0.05, scale: 14 }); // same plan, doorway now 0.7 m
  assert.ok(findPath(wide.grid, wide.marks.A, wide.marks.B, WALKER.standard), 'a person fits a 0.7 m door');
  assert.equal(findPath(wide.grid, wide.marks.A, wide.marks.B, WALKER.accessible), null, 'a 0.76 m wide chair does not');
});

test('a destination inside furniture resolves to standing next to it', () => {
  const { grid, marks } = gridFromArt(['#########', '#A......#', '#....##.#', '#....##.#', '#.......#', '#########']);
  const insideTable = [5.9 * 0.4, 2.9 * 0.4];
  const route = findPath(grid, marks.A, insideTable);
  assert.ok(route);
  assert.ok(Math.hypot(route.goal[0] - insideTable[0], route.goal[1] - insideTable[1]) < 0.8);
  assertCollisionFree(grid, route, WALKER.standard.radius);
});

test('planning is fast enough to re-run every frame on a venue-sized grid', () => {
  const rows = Array.from({ length: 60 }, (_, r) => (r === 0 || r === 59 ? '#'.repeat(80) : `#${'.'.repeat(78)}#`));
  rows[30] = `#${'#'.repeat(70)}${'.'.repeat(8)}#`;
  const { grid } = gridFromArt(rows, { res: 0.1, scale: 5 }); // 400 × 300 cells = 40 m × 30 m
  const t0 = performance.now();
  const route = findPath(grid, [1, 1], [1, 28]);
  const ms = performance.now() - t0;
  assert.ok(route && polylineLength(route.points) > 60);
  assert.ok(ms < 400, `planning took ${ms.toFixed(0)} ms`);
});
