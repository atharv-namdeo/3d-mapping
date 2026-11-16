/** POI categories: icon, colour and the everyday words people use for them. */
export const CATEGORIES = {
  room: { label: 'Room / area', icon: '▢', color: '#7c9cff', synonyms: ['room', 'area', 'zone', 'space', 'section'] },
  entrance: { label: 'Entrance / exit', icon: '⇥', color: '#34d399', synonyms: ['entrance', 'exit', 'door', 'entry', 'way out', 'doorway'] },
  seating: { label: 'Seating', icon: '◒', color: '#f59e0b', synonyms: ['seat', 'seating', 'chair', 'sofa', 'couch', 'bench', 'sit'] },
  table: { label: 'Table / desk', icon: '▭', color: '#fb923c', synonyms: ['table', 'desk', 'counter', 'worktop'] },
  appliance: { label: 'Appliance', icon: '⚡', color: '#22d3ee', synonyms: ['appliance', 'machine', 'device', 'electronics'] },
  storage: { label: 'Storage', icon: '▤', color: '#a78bfa', synonyms: ['storage', 'shelf', 'shelves', 'cabinet', 'cupboard', 'rack', 'wardrobe'] },
  food: { label: 'Food & drink', icon: '☕', color: '#f472b6', synonyms: ['food', 'drink', 'eat', 'coffee', 'water', 'kitchen', 'pantry', 'cafe'] },
  leisure: { label: 'Leisure', icon: '♪', color: '#e879f9', synonyms: ['music', 'play', 'leisure', 'entertainment', 'tv', 'game'] },
  service: { label: 'Service point', icon: '✚', color: '#f87171', synonyms: ['service', 'help', 'reception', 'restroom', 'toilet', 'washroom', 'first aid', 'info'] },
  landmark: { label: 'Landmark', icon: '◆', color: '#94a3b8', synonyms: ['landmark', 'pillar', 'column', 'plant', 'window', 'art'] },
};

export function categoryOf(poi) {
  return CATEGORIES[poi.category] ?? CATEGORIES.landmark;
}
