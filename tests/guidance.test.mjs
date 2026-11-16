import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSteps, projectOnRoute, pointAlong, progress, orderStops } from '../app/src/core/guidance.js';
import { Navigator } from '../app/src/core/navigator.js';
import { PoiStore } from '../app/src/core/poi-store.js';
import { gridFromArt, WALLED_ROOM } from './helpers.mjs';

// Walk +Z (south on the map), then turn towards +X, then towards −Z.
const DOGLEG = [[0, 0], [0, 5], [4, 5], [4, 2]];

test('turn directions are correct for the viewer-facing frame', () => {
  // Heading +Z then +X: with +Y up that is a LEFT turn (x × z points down).
  const steps = buildSteps(DOGLEG, { destination: 'Pantry' });
  assert.deepEqual(steps.map((s) => s.text), ['Head towards Pantry', 'Turn left', 'Turn left', 'Arrive at Pantry']);
  assert.deepEqual(steps.map((s) => s.at), [0, 5, 9, 12]);
  const right = buildSteps([[0, 0], [0, 5], [-4, 5]]);
  assert.equal(right[1].text, 'Turn right');
});

test('landmarks are woven into instructions, gentle bends are ignored', () => {
  const steps = buildSteps(DOGLEG, { destination: 'X', landmarkAt: (x, z) => (x === 0 && z === 5 ? 'the Printer' : null) });
  assert.equal(steps[1].text, 'Turn left at the Printer');
  const wobble = buildSteps([[0, 0], [0.2, 3], [0, 6]]);
  assert.equal(wobble.length, 2, 'a 7° wobble is not announced as a turn');
});

test('a rounded corner is announced once, not once per facet', () => {
  const arc = [[0, 0], [0, 4], [0.1, 4.4], [0.4, 4.7], [0.8, 4.8], [4, 4.8]];
  const turns = buildSteps(arc).filter((s) => s.icon !== 'straight' && s.icon !== 'arrive');
  assert.equal(turns.length, 1);
  assert.ok(Math.abs(Math.abs(turns[0].turnDeg) - 90) < 15);
});

test('projection and progress track a walker along the route', () => {
  const p = projectOnRoute(DOGLEG, 0.5, 3);
  assert.ok(Math.abs(p.along - 3) < 1e-9 && Math.abs(p.offset - 0.5) < 1e-9);
  assert.deepEqual(pointAlong(DOGLEG, 7).point, [2, 5]);
  const route = { points: DOGLEG, length: 12 };
  const state = progress(route, buildSteps(DOGLEG), 0, 4);
  assert.equal(state.next.text, 'Turn left');
  assert.ok(Math.abs(state.distanceToNext - 1) < 1e-9 && Math.abs(state.remaining - 8) < 1e-9);
});

test('multi-stop trips are re-ordered to the shortest tour', () => {
  const stops = [[10, 0], [1, 0], [5, 0], [2, 0]];
  const cost = (a, b) => Math.abs((a < 0 ? 0 : stops[a][0]) - stops[b][0]);
  assert.deepEqual(orderStops(stops.length, cost), [1, 3, 2, 0]);
});

test('Navigator: route → progress → automatic re-route → arrival', () => {
  const { grid, marks } = gridFromArt(WALLED_ROOM, { scale: 6 });
  const store = new PoiStore('t', [{ id: 'b', name: 'Target', position: [marks.B[0], 1, marks.B[1]] }]);
  const nav = new Navigator(grid, store);
  const events = [];
  for (const type of ['route', 'progress', 'reroute', 'arrive', 'unreachable']) nav.addEventListener(type, (e) => events.push([type, e.detail]));

  const route = nav.navigateTo(marks.A, store.get('b'));
  assert.ok(route && nav.active);
  assert.equal(events[0][0], 'route');
  assert.ok(Number.isFinite(nav.walkingDistance(marks.A, store.get('b'))));

  nav.update(route.points[0], 0.016);
  assert.equal(events.at(-1)[0], 'progress');
  assert.ok(events.at(-1)[1].remaining > 1);

  // Wander well off the route: after the cooldown a fresh route is planned from here.
  const stray = grid.nearestFree(marks.A[0] + 1.5, marks.A[1] + 2.0, 0.25);
  nav.update(stray, 1.0);
  assert.ok(events.some(([t]) => t === 'reroute'));
  assert.ok(Math.hypot(nav.route.start[0] - stray[0], nav.route.start[1] - stray[1]) < 0.2);

  nav.update(nav.route.goal, 0.016);
  assert.equal(events.at(-2)[0], 'arrive');
  assert.equal(events.at(-2)[1].final, true);
  assert.ok(!nav.active);
});

test('Navigator reports unreachable places instead of inventing a route', () => {
  const { grid, marks } = gridFromArt(['#########', '#A..#..B#', '#...#...#', '#########'], { scale: 6 });
  const nav = new Navigator(grid, new PoiStore('t', []));
  let unreachable = null;
  nav.addEventListener('unreachable', (e) => { unreachable = e.detail; });
  assert.equal(nav.navigateTo(marks.A, { name: 'Sealed room', target: marks.B }), null);
  assert.equal(unreachable.name, 'Sealed room');
  assert.ok(!nav.active);
});
