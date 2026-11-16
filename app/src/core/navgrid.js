/**
 * NavGrid — the walkable-floor raster produced by navkit, plus the spatial queries
 * everything else is built on (clearance, line of sight, snapping, ray picking).
 *
 * World frame: metres, +Y up, floor at y = 0. Cell (i, j) covers
 *   x ∈ [x0 + i·res, x0 + (i+1)·res),  z ∈ [z0 + j·res, z0 + (j+1)·res).
 */

function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let k = 0; k < binary.length; k++) bytes[k] = binary.charCodeAt(k);
  return bytes;
}

/** Exact squared Euclidean distance transform of one row/column (Felzenszwalb & Huttenlocher). */
function edt1d(f, n, out, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
    } while (s <= z[k] && --k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}

export class NavGrid {
  /**
   * @param {object} o
   * @param {number} o.resolution  cell size in metres
   * @param {[number, number]} o.origin  world (x, z) of the grid's min corner
   * @param {[number, number]} o.size  [columns, rows]
   * @param {Uint8Array} o.walkable  1 = observed free floor, row-major
   * @param {Float32Array} [o.obstacleHeight]  metres above the floor, 0 = nothing
   */
  constructor({ resolution, origin, size, walkable, obstacleHeight }) {
    this.res = resolution;
    [this.x0, this.z0] = origin;
    [this.width, this.height] = size;
    this.walkable = walkable;
    this.obstacleHeight = obstacleHeight ?? new Float32Array(walkable.length);
    this.clearance = this.#computeClearance();
    this.walkableArea = walkable.reduce((sum, w) => sum + w, 0) * resolution * resolution;
  }

  /** Decode the `nav.json` written by `navkit build`. */
  static fromJSON(nav) {
    const [w, h] = nav.size;
    const bits = decodeBase64(nav.walkable);
    const walkable = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) walkable[k] = (bits[k >> 3] >> (k & 7)) & 1;
    const raw = nav.obstacleHeight ? decodeBase64(nav.obstacleHeight) : null;
    const obstacleHeight = new Float32Array(w * h);
    if (raw) for (let k = 0; k < w * h; k++) obstacleHeight[k] = raw[k] * (nav.heightStep ?? 0.02);
    return new NavGrid({ resolution: nav.resolution, origin: nav.origin, size: nav.size, walkable, obstacleHeight });
  }

  /** Distance (m) from each walkable cell centre to the edge of the nearest blocked cell. */
  #computeClearance() {
    const { width: w, height: h, walkable } = this;
    const INF = 1e12;
    const n = Math.max(w, h);
    const f = new Float64Array(n), out = new Float64Array(n), z = new Float64Array(n + 1);
    const v = new Int32Array(n);
    const sq = new Float64Array(w * h);
    for (let k = 0; k < w * h; k++) sq[k] = walkable[k] ? INF : 0;
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) f[j] = sq[j * w + i];
      edt1d(f, h, out, v, z);
      for (let j = 0; j < h; j++) sq[j * w + i] = out[j];
    }
    const clearance = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) f[i] = sq[j * w + i];
      edt1d(f, w, out, v, z);
      for (let i = 0; i < w; i++) {
        // Everything beyond the grid is unknown, hence blocked.
        const border = Math.min(i + 1, j + 1, w - i, h - j);
        const cells = Math.min(Math.sqrt(out[i]), border);
        clearance[j * w + i] = Math.max(0, (cells - 0.5) * this.res);
      }
    }
    return clearance;
  }

  index(i, j) { return j * this.width + i; }
  inBounds(i, j) { return i >= 0 && j >= 0 && i < this.width && j < this.height; }
  cellOf(x, z) { return [Math.floor((x - this.x0) / this.res), Math.floor((z - this.z0) / this.res)]; }
  centerOf(i, j) { return [this.x0 + (i + 0.5) * this.res, this.z0 + (j + 0.5) * this.res]; }

  /** World-space bounds of the whole grid. */
  get bounds() {
    return { minX: this.x0, minZ: this.z0, maxX: this.x0 + this.width * this.res, maxZ: this.z0 + this.height * this.res };
  }

  /** Bilinearly interpolated clearance in metres (0 outside the grid). */
  clearanceAt(x, z) {
    const gx = (x - this.x0) / this.res - 0.5, gz = (z - this.z0) / this.res - 0.5;
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const at = (a, b) => (this.inBounds(a, b) ? this.clearance[b * this.width + a] : 0);
    return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fz) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fz;
  }

  /** Can a disc of `radius` metres stand at (x, z)? */
  isFree(x, z, radius = 0) {
    const [i, j] = this.cellOf(x, z);
    if (!this.inBounds(i, j) || !this.walkable[this.index(i, j)]) return false;
    return radius <= 0 || this.clearanceAt(x, z) >= radius;
  }

  /** Can a disc of `radius` slide straight from a to b without touching anything? */
  lineOfSight(ax, az, bx, bz, radius = 0) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(dist / (this.res * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (!this.isFree(ax + (bx - ax) * t, az + (bz - az) * t, radius)) return false;
    }
    return true;
  }

  /** Closest position where a disc of `radius` fits, or null if none within `maxDistance`. */
  nearestFree(x, z, radius = 0, maxDistance = Infinity) {
    if (this.isFree(x, z, radius)) return [x, z];
    let best = null, bestD = maxDistance * maxDistance;
    for (let j = 0; j < this.height; j++) {
      for (let i = 0; i < this.width; i++) {
        const k = j * this.width + i;
        if (!this.walkable[k] || this.clearance[k] < radius) continue;
        const cx = this.x0 + (i + 0.5) * this.res, cz = this.z0 + (j + 0.5) * this.res;
        const d = (cx - x) * (cx - x) + (cz - z) * (cz - z);
        if (d < bestD) { bestD = d; best = [cx, cz]; }
      }
    }
    return best;
  }

  /** Height (m) of whatever stands at (x, z); 0 on open floor or unknown space. */
  heightAt(x, z) {
    const [i, j] = this.cellOf(x, z);
    return this.inBounds(i, j) ? this.obstacleHeight[this.index(i, j)] : 0;
  }

  /**
   * March a ray through the obstacle heightfield — how clicks in the 3D view are
   * resolved to a place, without needing a mesh of the reconstruction.
   * @returns {{point: [number, number, number], onFloor: boolean, distance: number} | null}
   */
  raycast(origin, direction, maxDistance = 40) {
    const step = this.res * 0.5;
    let [x, y, z] = origin;
    const [dx, dy, dz] = direction;
    for (let t = 0; t <= maxDistance; t += step) {
      x = origin[0] + dx * t; y = origin[1] + dy * t; z = origin[2] + dz * t;
      if (y <= 0) {
        const back = dy !== 0 ? y / dy : 0; // step back onto the floor plane exactly
        return { point: [x - dx * back, 0, z - dz * back], onFloor: true, distance: t - back };
      }
      const h = this.heightAt(x, z);
      if (h > 0 && y <= h) return { point: [x, y, z], onFloor: false, distance: t };
    }
    return null;
  }
}
