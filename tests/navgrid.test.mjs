import test from 'node:test';
import assert from 'node:assert/strict';
import { NavGrid } from '../app/src/core/navgrid.js';
import { gridFromArt, WALLED_ROOM } from './helpers.mjs';

test('clearance is the distance to the nearest blocked cell edge', () => {
  // 1 m wide corridor at 0.1 m cells: centre line is ~0.5 m from both walls.
  const { grid } = gridFromArt(['##########', '#........#', '##########'], { res: 0.1, scale: 10 });
  const mid = grid.clearanceAt(5.0, 1.5);
  assert.ok(Math.abs(mid - 0.45) < 0.051, `corridor centre clearance ${mid}`);
  assert.equal(grid.clearanceAt(5.0, 0.5), 0, 'inside a wall');
  assert.equal(grid.clearanceAt(-3, -3), 0, 'outside the grid counts as blocked');
});

test('isFree respects the walker radius', () => {
  const { grid } = gridFromArt(['##########', '#........#', '##########'], { res: 0.1, scale: 10 });
  assert.ok(grid.isFree(5, 1.5, 0.3));
  assert.ok(!grid.isFree(5, 1.5, 0.6), 'a 1.2 m wide body does not fit a 1 m corridor');
  assert.ok(!grid.isFree(5, 1.08, 0.3), 'too close to the wall');
});

test('lineOfSight is blocked by walls and open through the doorway', () => {
  const { grid, marks } = gridFromArt(WALLED_ROOM);
  assert.ok(!grid.lineOfSight(...marks.A, ...marks.B, 0.1), 'wall between A and B');
  assert.ok(grid.lineOfSight(marks.A[0], marks.A[1], marks.A[0] + 1, marks.A[1], 0.1));
});

test('nearestFree snaps a point inside an obstacle to standing room beside it', () => {
  const { grid } = gridFromArt(WALLED_ROOM);
  const inWall = [9.5 * 0.4, 2 * 0.4];
  assert.ok(!grid.isFree(...inWall, 0.2));
  const snapped = grid.nearestFree(...inWall, 0.2);
  assert.ok(grid.isFree(...snapped, 0.2));
  assert.ok(Math.hypot(snapped[0] - inWall[0], snapped[1] - inWall[1]) < 0.6);
});

test('raycast hits the floor, and obstacles that are tall enough', () => {
  const walkable = new Uint8Array(100).fill(1);
  const obstacleHeight = new Float32Array(100);
  walkable[55] = 0; obstacleHeight[55] = 1.0; // a 1 m high box at cell (5, 5)
  const grid = new NavGrid({ resolution: 1, origin: [0, 0], size: [10, 10], walkable, obstacleHeight });
  const down = grid.raycast([2.5, 2, 2.5], [0, -1, 0]);
  assert.ok(down.onFloor && Math.abs(down.point[1]) < 1e-9);
  const box = grid.raycast([5.5, 3, 5.5], [0, -1, 0]);
  assert.ok(!box.onFloor && Math.abs(box.point[1] - 1) < 0.6, 'stops on top of the box');
  const side = grid.raycast([0.5, 0.5, 5.5], [1, 0, 0]);
  assert.ok(!side.onFloor && side.point[0] >= 5 && side.point[0] <= 5.6, 'stops at the side of the box');
  assert.equal(grid.raycast([2.5, 2, 2.5], [0, 1, 0]), null, 'looking at the sky hits nothing');
});

test('fromJSON round-trips the packed nav.json encoding', () => {
  const bits = new Uint8Array([0b00000110, 0b1]); // cells 1, 2 and 8 walkable in a 3×3 grid
  const nav = {
    resolution: 0.5, origin: [1, 2], size: [3, 3], heightStep: 0.02,
    walkable: btoa(String.fromCharCode(...bits)),
    obstacleHeight: btoa(String.fromCharCode(50, 0, 0, 0, 0, 0, 0, 0, 0)),
  };
  const grid = NavGrid.fromJSON(nav);
  assert.deepEqual([...grid.walkable], [0, 1, 1, 0, 0, 0, 0, 0, 1]);
  assert.ok(Math.abs(grid.obstacleHeight[0] - 1.0) < 1e-6);
  assert.deepEqual(grid.cellOf(1.6, 2.1), [1, 0]);
});
