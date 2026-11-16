/**
 * PoiStore — the scene's points of interest and zones.
 *
 * Published POIs come from `scenes/<id>/pois.json`. Edits made in the in-browser
 * editor are kept as a local draft (localStorage) layered on top, and can be
 * exported as a new `pois.json` to commit — so tagging a venue needs no tooling.
 *
 * POI shape:
 *   { id, name, category, aliases?: string[], description?: string,
 *     position: [x, y, z],          // label anchor in metres
 *     zone?: [x, z][] }             // optional floor polygon (rooms / areas)
 */
import { SpatialIndex, polygonCentroid } from './spatial-index.js';
import { SearchIndex } from './search.js';

export function slugify(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'poi';
}

export function validatePoi(poi) {
  const problems = [];
  if (!poi.id) problems.push('missing id');
  if (!poi.name?.trim()) problems.push('missing name');
  if (!Array.isArray(poi.position) || poi.position.length !== 3 || !poi.position.every(Number.isFinite)) problems.push('position must be [x, y, z]');
  if (poi.zone && (!Array.isArray(poi.zone) || poi.zone.length < 3)) problems.push('zone needs at least 3 corners');
  return problems;
}

export class PoiStore extends EventTarget {
  /**
   * @param {string} sceneId
   * @param {object[]} published  contents of pois.json
   * @param {Storage | null} storage  where drafts persist (null = memory only)
   */
  constructor(sceneId, published = [], storage = null) {
    super();
    this.sceneId = sceneId;
    this.storage = storage;
    this.published = published;
    this.spatial = new SpatialIndex(1);
    this.search = new SearchIndex();
    this.pois = this.#loadDraft() ?? structuredClone(published);
    this.#reindex();
  }

  get #draftKey() { return `namma-space:pois:${this.sceneId}`; }
  get hasDraft() { return Boolean(this.storage?.getItem(this.#draftKey)); }

  #loadDraft() {
    try {
      const raw = this.storage?.getItem(this.#draftKey);
      const draft = raw ? JSON.parse(raw) : null;
      return Array.isArray(draft) ? draft : null;
    } catch {
      return null; // corrupt or unavailable storage must never break the viewer
    }
  }

  #reindex() {
    this.spatial.rebuild(this.pois);
    this.search.rebuild(this.pois);
  }

  #commit() {
    this.#reindex();
    try { this.storage?.setItem(this.#draftKey, JSON.stringify(this.pois)); } catch { /* storage full or blocked */ }
    this.dispatchEvent(new Event('change'));
  }

  get(id) { return this.pois.find((p) => p.id === id) ?? null; }

  #uniqueId(name) {
    const base = slugify(name);
    let id = base;
    for (let n = 2; this.get(id); n++) id = `${base}-${n}`;
    return id;
  }

  /** Add or update. Returns the stored POI; throws on invalid data. */
  upsert(input) {
    const poi = { category: 'landmark', aliases: [], description: '', ...input };
    poi.name = poi.name?.trim();
    if (!poi.id) poi.id = this.#uniqueId(poi.name ?? 'poi');
    if (poi.zone?.length >= 3 && !input.position) {
      const [x, z] = polygonCentroid(poi.zone);
      poi.position = [x, 1.2, z];
    }
    const problems = validatePoi(poi);
    if (problems.length) throw new Error(`Invalid POI: ${problems.join(', ')}`);
    const existing = this.pois.findIndex((p) => p.id === poi.id);
    if (existing >= 0) this.pois[existing] = poi; else this.pois.push(poi);
    this.#commit();
    return poi;
  }

  remove(id) {
    const before = this.pois.length;
    this.pois = this.pois.filter((p) => p.id !== id);
    if (this.pois.length !== before) this.#commit();
  }

  /** Throw away the local draft and return to what is published in the repository. */
  discardDraft() {
    try { this.storage?.removeItem(this.#draftKey); } catch { /* ignore */ }
    this.pois = structuredClone(this.published);
    this.#reindex();
    this.dispatchEvent(new Event('change'));
  }

  /** Pretty JSON ready to be committed as `scenes/<id>/pois.json`. */
  export() {
    const round = (v) => Math.round(v * 1000) / 1000;
    const clean = this.pois.map((p) => ({
      id: p.id, name: p.name, category: p.category,
      ...(p.aliases?.length ? { aliases: p.aliases } : {}),
      ...(p.description ? { description: p.description } : {}),
      position: p.position.map(round),
      ...(p.zone ? { zone: p.zone.map((c) => c.map(round)) } : {}),
    }));
    return JSON.stringify(clean, null, 2) + '\n';
  }
}
