/** Shared fixtures: hand-built grids whose correct answers are known by construction. */
import { NavGrid } from '../app/src/core/navgrid.js';

/**
 * Build a grid from ASCII art: '#' wall, '.' floor, letters are floor cells
 * returned as named world positions. Each character is `scale` × `scale` cells.
 */
export function gridFromArt(rows, { res = 0.1, scale = 4 } = {}) {
  const h = rows.length * scale, w = rows[0].length * scale;
  const walkable = new Uint8Array(w * h);
  const marks = {};
  rows.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch === '#') return;
    for (let dj = 0; dj < scale; dj++) for (let di = 0; di < scale; di++) walkable[(r * scale + dj) * w + c * scale + di] = 1;
    if (ch !== '.') marks[ch] = [(c + 0.5) * scale * res, (r + 0.5) * scale * res];
  }));
  const grid = new NavGrid({ resolution: res, origin: [0, 0], size: [w, h], walkable });
  return { grid, marks };
}

/** A room split by a wall with a single doorway: the only way from A to B is through the gap. */
export const WALLED_ROOM = [
  '####################',
  '#........#.........#',
  '#.A......#.........#',
  '#........#.........#',
  '#........#.....B...#',
  '#........#.........#',
  '#..................#',
  '#........#.........#',
  '#........#.........#',
  '####################',
];
