/**
 * Spatial search: typo-tolerant text matching ranked together with walking distance.
 *
 * "nearest chair", "take me to the piano", "dinning tabel" and "coffee" all work:
 *   – filler words are stripped and "nearest/closest" switches ranking to distance-first,
 *   – every remaining word must match the POI's name, an alias, its category
 *     (including everyday synonyms) or its description,
 *   – matches are scored exact > prefix > substring > fuzzy (Damerau–Levenshtein).
 */
import { CATEGORIES } from './categories.js';

const FILLER = new Set(['a', 'an', 'the', 'to', 'me', 'my', 'is', 'are', 'i', 'of', 'in', 'at', 'for', 'please', 'can', 'you',
  'where', 'wheres', 'find', 'show', 'take', 'go', 'goto', 'navigate', 'route', 'walk', 'get', 'guide', 'want', 'need', 'how', 'do', 'whats', 'what']);
const PROXIMITY = new Set(['nearest', 'closest', 'nearby', 'near', 'close']);

export function normalise(text) {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const tokenise = (text) => normalise(text).split(' ').filter(Boolean);

/** Optimal-string-alignment distance with an early exit once `limit` is exceeded. */
export function editDistance(a, b, limit = 2) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > limit) return limit + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** How well one query word matches one indexed word, in [0, 1]. */
function wordScore(query, word) {
  if (query === word) return 1;
  if (word.startsWith(query)) return 0.9 - 0.1 * (1 - query.length / word.length);
  if (query.length >= 3 && word.includes(query)) return 0.7;
  const tolerance = query.length >= 8 ? 2 : query.length >= 4 ? 1 : 0;
  if (tolerance && editDistance(query, word, tolerance) <= tolerance) return 0.6;
  // Typo in a word the user is still typing: compare against the word's prefix.
  if (tolerance && word.length > query.length && editDistance(query, word.slice(0, query.length), 1) <= 1) return 0.5;
  return 0;
}

const FIELD_WEIGHT = { name: 1, alias: 0.95, category: 0.75, description: 0.45 };

function indexPoi(poi) {
  const category = CATEGORIES[poi.category];
  return {
    poi,
    fields: [
      { kind: 'name', words: tokenise(poi.name) },
      ...(poi.aliases ?? []).map((alias) => ({ kind: 'alias', words: tokenise(alias) })),
      { kind: 'category', words: tokenise([poi.category, category?.label, ...(category?.synonyms ?? [])].join(' ')) },
      { kind: 'description', words: tokenise(poi.description) },
    ],
  };
}

export class SearchIndex {
  constructor(pois = []) { this.rebuild(pois); }

  rebuild(pois) { this.entries = pois.map(indexPoi); }

  /** Split free text into the words to match and whether the user asked for "the nearest …". */
  parse(text) {
    const words = tokenise(text);
    const nearest = words.some((w) => PROXIMITY.has(w));
    const terms = words.filter((w) => !FILLER.has(w) && !PROXIMITY.has(w));
    return { terms, nearest };
  }

  /**
   * @param {string} text
   * @param {object} [opts]
   * @param {(poi) => number} [opts.distanceTo]  walking distance in metres (Infinity = unreachable)
   * @param {number} [opts.limit]
   * @returns {{poi, score: number, distance: number, matched: string}[]}
   */
  query(text, { distanceTo = () => 0, limit = 8 } = {}) {
    const { terms, nearest } = this.parse(text);
    const typed = tokenise(text).join(' ');
    const results = [];
    for (const { poi, fields } of this.entries) {
      const distance = distanceTo(poi);
      if (!terms.length) { results.push({ poi, score: 0, distance, matched: 'all' }); continue; }
      let total = 0, matched = 'name', bestField = 0;
      for (const term of terms) {
        let best = 0, bestKind = null;
        for (const field of fields) {
          for (const word of field.words) {
            const s = wordScore(term, word) * FIELD_WEIGHT[field.kind];
            if (s > best) { best = s; bestKind = field.kind; }
          }
        }
        if (best === 0) { total = 0; break; } // every word must match something
        total += best;
        if (best > bestField) { bestField = best; matched = bestKind; }
      }
      if (total > 0) {
        // Typing a place's exact name must always beat partial matches elsewhere.
        const name = fields[0].words.join(' ');
        const exact = name === typed || name === terms.join(' ') ? 0.5 : 0;
        results.push({ poi, score: total / terms.length + exact, distance, matched });
      }
    }
    const byDistance = (a, b) => a.distance - b.distance || a.poi.name.localeCompare(b.poi.name);
    if (!terms.length || nearest) results.sort(byDistance);
    else results.sort((a, b) => (Math.abs(b.score - a.score) > 0.08 ? b.score - a.score : byDistance(a, b)));
    return results.slice(0, limit);
  }
}
