import test from 'node:test';
import assert from 'node:assert/strict';
import { SpatialIndex, pointInPolygon, polygonArea } from '../app/src/core/spatial-index.js';
import { PoiStore, slugify } from '../app/src/core/poi-store.js';

const room = { id: 'room', name: 'Meeting Room A', position: [5, 1, 5], zone: [[0, 0], [10, 0], [10, 10], [0, 10]] };
const nook = { id: 'nook', name: 'Phone nook', position: [2, 1, 2], zone: [[1, 1], [3, 1], [3, 3], [1, 3]] };
const lamp = { id: 'lamp', name: 'Lamp', position: [8, 1, 8] };

test('point-in-polygon handles concave shapes', () => {
  const L = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
  assert.ok(pointInPolygon(1, 3, L));
  assert.ok(!pointInPolygon(3, 3, L), 'inside the bounding box but outside the L');
  assert.equal(polygonArea(L), 12);
});

test('radius and nearest queries agree with brute force on random data', () => {
  const index = new SpatialIndex(1);
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 40 - 20;
  const pts = Array.from({ length: 400 }, (_, k) => ({ id: `p${k}`, position: [rnd(), 0, rnd()] }));
  index.rebuild(pts);
  for (const [x, z, r] of [[0, 0, 3], [-12.5, 7.2, 5.5], [19, 19, 2], [100, 100, 1]]) {
    const brute = pts.filter((p) => Math.hypot(p.position[0] - x, p.position[2] - z) <= r).map((p) => p.id).sort();
    assert.deepEqual(index.withinRadius(x, z, r).map((h) => h.poi.id).sort(), brute);
  }
  const nearestBrute = [...pts].sort((a, b) => Math.hypot(a.position[0] - 3, a.position[2] + 4) - Math.hypot(b.position[0] - 3, b.position[2] + 4)).slice(0, 5).map((p) => p.id);
  assert.deepEqual(index.nearest(3, -4, 5).map((h) => h.poi.id), nearestBrute);
});

test('a click resolves to the nearest POI, else the smallest zone containing it', () => {
  const index = new SpatialIndex(1);
  index.rebuild([room, nook, lamp]);
  assert.equal(index.resolve(8.2, 8.1).id, 'lamp', 'a POI right there wins');
  assert.equal(index.resolve(2.6, 2.9).id, 'nook', 'the more specific zone wins over the room around it');
  assert.equal(index.resolve(6, 2).id, 'room');
  assert.equal(index.resolve(30, 30), null, 'outside everything');
  assert.deepEqual(index.zonesAt(2.2, 1.4).map((p) => p.id), ['nook', 'room']);
});

test('PoiStore: add, edit, delete, draft persistence and export', () => {
  const memory = new Map();
  const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  const store = new PoiStore('demo', [lamp], storage);
  let changes = 0;
  store.addEventListener('change', () => changes++);

  const a = store.upsert({ name: '  Reception ', category: 'service', position: [1, 1, 1] });
  assert.equal(a.id, 'reception');
  assert.equal(a.name, 'Reception');
  assert.equal(store.upsert({ name: 'Reception', position: [2, 1, 2] }).id, 'reception-2', 'ids stay unique');
  const zone = store.upsert({ name: 'Lobby', zone: [[0, 0], [4, 0], [4, 4], [0, 4]] });
  assert.deepEqual(zone.position, [2, 1.2, 2], 'a zone without an anchor is labelled at its centroid');
  assert.throws(() => store.upsert({ name: '', position: [0, 0, 0] }), /missing name/);
  assert.throws(() => store.upsert({ name: 'Bad', position: [0, NaN, 0] }), /position/);

  assert.equal(store.search.query('lobby')[0].poi.id, 'lobby', 'search index follows edits');
  assert.equal(store.spatial.resolve(3.5, 3.5).id, 'lobby', 'spatial index follows edits');
  store.remove('reception-2');
  assert.equal(store.get('reception-2'), null);
  assert.equal(changes, 4);

  const reopened = new PoiStore('demo', [lamp], storage);
  assert.deepEqual(reopened.pois.map((p) => p.id).sort(), ['lamp', 'lobby', 'reception'], 'drafts survive a reload');
  assert.deepEqual(JSON.parse(reopened.export()).map((p) => p.id).sort(), ['lamp', 'lobby', 'reception']);
  reopened.discardDraft();
  assert.deepEqual(reopened.pois.map((p) => p.id), ['lamp']);
  assert.equal(slugify('Meeting Room #4 (East)'), 'meeting-room-4-east');
});

test('PoiStore survives corrupt or unavailable storage', () => {
  const broken = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const store = new PoiStore('demo', [lamp], broken);
  assert.equal(store.pois.length, 1);
  assert.doesNotThrow(() => store.upsert({ name: 'X', position: [0, 0, 0] }));
  assert.equal(new PoiStore('demo', [lamp], null).pois.length, 1);
});
