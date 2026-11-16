import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchIndex, editDistance, normalise } from '../app/src/core/search.js';

const POIS = [
  { id: 'a', name: 'Meeting Room A', category: 'room', aliases: ['conference room'], position: [0, 1, 0] },
  { id: 'b', name: 'Meeting Room B', category: 'room', aliases: ['conference room'], position: [9, 1, 0] },
  { id: 'sofa', name: 'Lounge sofas', category: 'seating', aliases: ['3-seater sofas', 'couch'], position: [4, 1, 4] },
  { id: 'chair', name: 'Visitor chair', category: 'seating', position: [1, 1, 1] },
  { id: 'coffee', name: 'Coffee machine', category: 'food', description: 'Bean-to-cup espresso', position: [6, 1, 2] },
  { id: 'cafe', name: 'Café Mysore', category: 'food', position: [7, 1, 7] },
];
const index = new SearchIndex(POIS);
const distanceTo = (poi) => Math.hypot(poi.position[0], poi.position[2]);
const ids = (text, opts) => index.query(text, { distanceTo, ...opts }).map((r) => r.poi.id);

test('exact and prefix matches rank first', () => {
  assert.equal(ids('coffee machine')[0], 'coffee');
  assert.equal(ids('cof')[0], 'coffee');
  assert.deepEqual(ids('meeting room b').slice(0, 1), ['b']);
});

test('typos and transpositions are tolerated', () => {
  assert.equal(ids('cofee machne')[0], 'coffee');
  assert.equal(ids('meetign')[0], 'a');
  assert.equal(editDistance('sofa', 'sfoa'), 1, 'a swap of adjacent letters is one edit');
  assert.ok(editDistance('sofa', 'table') > 2);
});

test('aliases and the brief\'s own example resolve', () => {
  assert.equal(ids('3-seater sofas')[0], 'sofa');
  assert.equal(ids('couch')[0], 'sofa');
  assert.deepEqual(ids('conference').sort(), ['a', 'b']);
});

test('category words find every member, nearest first', () => {
  assert.deepEqual(ids('seating'), ['chair', 'sofa']);
  assert.deepEqual(ids('somewhere to sit'), [], 'unknown words must all match — no false positives');
  assert.deepEqual(ids('sit'), ['chair', 'sofa'], 'everyday synonym of the seating category');
});

test('natural phrasing: fillers are ignored and "nearest" ranks by walking distance', () => {
  assert.equal(ids('take me to the coffee machine please')[0], 'coffee');
  assert.equal(ids('where is the nearest meeting room')[0], 'a');
  assert.equal(index.parse('Where is the nearest chair?').nearest, true);
  assert.deepEqual(index.parse('Where is the nearest chair?').terms, ['chair']);
});

test('accents and punctuation do not matter', () => {
  assert.equal(normalise('Café  Mysore!'), 'cafe mysore');
  assert.equal(ids('cafe mysore')[0], 'cafe');
});

test('an empty query lists everything by distance; unreachable places sink', () => {
  assert.equal(ids('', { limit: 10 })[0], 'a');
  const far = index.query('meeting', { distanceTo: (p) => (p.id === 'a' ? Infinity : 1) });
  assert.equal(far[0].poi.id, 'b');
});

test('nonsense returns nothing rather than a bad guess', () => {
  assert.deepEqual(ids('xyzzy'), []);
});
