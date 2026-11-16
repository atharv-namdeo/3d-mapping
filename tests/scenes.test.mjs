/** The shipped scenes themselves: every published POI must be valid, findable and reachable. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { NavGrid } from '../app/src/core/navgrid.js';
import { findPath, WALKER } from '../app/src/core/pathfinder.js';
import { PoiStore, validatePoi } from '../app/src/core/poi-store.js';
import { CATEGORIES } from '../app/src/core/categories.js';

const root = new URL('../app/scenes/', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root)));

for (const { id } of read('index.json').scenes) {
  test(`scene "${id}": bundle is complete and every POI is reachable on foot`, () => {
    const scene = read(`${id}/scene.json`);
    const nav = read(`${id}/nav.json`);
    const pois = read(`${id}/pois.json`);
    assert.equal(scene.id, id);
    for (const asset of [nav.assets.floorplan, nav.assets.splat, nav.assets.splatLite, nav.assets.points].filter(Boolean)) {
      assert.ok(existsSync(new URL(`${id}/${asset}`, root)), `${asset} is missing — run "python -m navkit build"`);
    }
    const grid = NavGrid.fromJSON(nav);
    assert.ok(grid.walkableArea > 5, 'has a meaningful walkable area');
    assert.ok(pois.length >= 8, 'has a useful number of POIs');
    assert.equal(new Set(pois.map((p) => p.id)).size, pois.length, 'POI ids are unique');

    const store = new PoiStore(id, pois);
    const start = scene.spawn?.position ?? grid.centerOf(...(() => { let b = 0; grid.clearance.forEach((c, k) => { if (c > grid.clearance[b]) b = k; }); return [b % grid.width, Math.floor(b / grid.width)]; })());
    assert.ok(grid.nearestFree(start[0], start[1], 0.2, 1), 'spawn point is on walkable floor');
    for (const poi of pois) {
      assert.deepEqual(validatePoi(poi), [], poi.id);
      assert.ok(poi.category in CATEGORIES, `${poi.id}: unknown category ${poi.category}`);
      assert.equal(store.search.query(poi.name)[0].poi.id, poi.id, `searching "${poi.name}" finds it first`);
      const route = findPath(grid, start, [poi.position[0], poi.position[2]], WALKER.standard);
      assert.ok(route, `${poi.id} is reachable from the spawn point`);
      assert.ok(route.minClearance >= WALKER.standard.radius - 1e-3, `${poi.id}: route keeps body clearance`);
      const end = Math.hypot(route.goal[0] - poi.position[0], route.goal[1] - poi.position[2]);
      assert.ok(end < 2.5, `${poi.id}: route ends ${end.toFixed(1)} m from it`);
    }
  });
}
