/**
 * SpatialIndex — a uniform hash grid over POIs for "what is here / near here" queries.
 * Points are bucketed by position; zones (polygons) are bucketed by bounding box and
 * confirmed with an exact point-in-polygon test.
 */

export function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
    const [xa, za] = polygon[a], [xb, zb] = polygon[b];
    if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
  }
  return inside;
}

export function polygonArea(polygon) {
  let twice = 0;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
    twice += polygon[b][0] * polygon[a][1] - polygon[a][0] * polygon[b][1];
  }
  return Math.abs(twice) / 2;
}

export function polygonCentroid(polygon) {
  let x = 0, z = 0;
  for (const p of polygon) { x += p[0]; z += p[1]; }
  return [x / polygon.length, z / polygon.length];
}

export class SpatialIndex {
  constructor(cellSize = 1) {
    this.cellSize = cellSize;
    this.clear();
  }

  clear() {
    this.points = new Map();   // "cx,cz" -> POI[]
    this.zones = new Map();    // "cx,cz" -> POI[]
    this.count = 0;
  }

  #key(cx, cz) { return `${cx},${cz}`; }
  #cell(v) { return Math.floor(v / this.cellSize); }

  insert(poi) {
    const key = this.#key(this.#cell(poi.position[0]), this.#cell(poi.position[2]));
    if (!this.points.has(key)) this.points.set(key, []);
    this.points.get(key).push(poi);
    if (poi.zone?.length >= 3) {
      const xs = poi.zone.map((p) => p[0]), zs = poi.zone.map((p) => p[1]);
      for (let cx = this.#cell(Math.min(...xs)); cx <= this.#cell(Math.max(...xs)); cx++) {
        for (let cz = this.#cell(Math.min(...zs)); cz <= this.#cell(Math.max(...zs)); cz++) {
          const k = this.#key(cx, cz);
          if (!this.zones.has(k)) this.zones.set(k, []);
          this.zones.get(k).push(poi);
        }
      }
    }
    this.count++;
  }

  rebuild(pois) {
    this.clear();
    for (const poi of pois) this.insert(poi);
  }

  /** POIs whose anchor lies within `radius` metres (floor distance), nearest first. */
  withinRadius(x, z, radius) {
    const found = [];
    const r = Math.ceil(radius / this.cellSize);
    const cx0 = this.#cell(x), cz0 = this.#cell(z);
    for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
      for (let cz = cz0 - r; cz <= cz0 + r; cz++) {
        for (const poi of this.points.get(this.#key(cx, cz)) ?? []) {
          const distance = Math.hypot(poi.position[0] - x, poi.position[2] - z);
          if (distance <= radius) found.push({ poi, distance });
        }
      }
    }
    return found.sort((a, b) => a.distance - b.distance);
  }

  /** The k nearest POIs by straight-line floor distance (expanding ring search). */
  nearest(x, z, k = 1) {
    if (!this.count) return [];
    for (let radius = this.cellSize; ; radius *= 2) {
      const found = this.withinRadius(x, z, radius);
      if (found.length >= Math.min(k, this.count)) return found.slice(0, k);
    }
  }

  /** Zones containing the point, smallest (most specific) first. */
  zonesAt(x, z) {
    const bucket = this.zones.get(this.#key(this.#cell(x), this.#cell(z))) ?? [];
    return bucket
      .filter((poi) => pointInPolygon(x, z, poi.zone))
      .sort((a, b) => polygonArea(a.zone) - polygonArea(b.zone));
  }

  /**
   * Resolve a picked 3D point to the thing the user most plausibly meant:
   * a POI anchored right there, otherwise the zone they clicked inside.
   */
  resolve(x, z, pickRadius = 0.6) {
    const hit = this.withinRadius(x, z, pickRadius)[0];
    if (hit) return hit.poi;
    return this.zonesAt(x, z)[0] ?? null;
  }
}
