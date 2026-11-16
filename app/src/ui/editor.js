/**
 * Editor — tag a venue from inside the walkthrough, no tools required.
 *
 *   click the scene      → place a new POI there (or pick an existing one to edit)
 *   "Draw zone"          → click floor corners to outline a room / area
 *   suggestions          → furniture-sized objects and open areas that navkit found
 *                          but nobody has named yet; one click to jump there and label it
 *   "Export pois.json"   → download the file to commit to the repository
 */
import { CATEGORIES } from '../core/categories.js';
import { polygonArea } from '../core/spatial-index.js';
import { $, el, toast } from './dom.js';

export class Editor extends EventTarget {
  constructor(store, suggestions = []) {
    super();
    this.store = store;
    this.suggestions = suggestions;
    this.root = $('#editor');
    this.open = false;
    this.draft = null;        // POI being created / edited
    this.drawing = false;     // collecting zone corners
    store.addEventListener('change', () => { if (this.open) this.render(); });
  }

  toggle(force) {
    this.open = force ?? !this.open;
    this.root.hidden = !this.open;
    if (!this.open) { this.draft = null; this.drawing = false; this.#emitZone(); }
    this.render();
    this.dispatchEvent(new CustomEvent('toggle', { detail: this.open }));
  }

  /** A click in the 3D view while editing. `hit` comes from NavGrid.raycast. */
  handlePick(hit, existing) {
    if (this.drawing && this.draft) {
      this.draft.zone = [...(this.draft.zone ?? []), [hit.point[0], hit.point[2]]];
      this.#emitZone();
      this.render();
      return;
    }
    if (existing) { this.edit(existing); return; }
    const y = hit.onFloor ? 1.1 : Math.min(2.2, hit.point[1] + 0.3);
    this.draft = { name: '', category: hit.onFloor ? 'room' : 'landmark', aliases: [], description: '', position: [hit.point[0], y, hit.point[2]] };
    this.render();
    this.root.querySelector('input[name=name]')?.focus();
  }

  edit(poi) {
    this.draft = structuredClone(poi);
    this.drawing = false;
    this.#emitZone();
    this.render();
  }

  #emitZone() { this.dispatchEvent(new CustomEvent('zone', { detail: this.draft?.zone ?? null })); }

  #unlabelled() {
    // A suggestion is "done" once any POI sits on top of it.
    return this.suggestions.filter((s) => !this.store.spatial.withinRadius(s.position[0], s.position[1], 0.7).length);
  }

  #save(form) {
    const data = new FormData(form);
    try {
      const saved = this.store.upsert({
        ...this.draft,
        name: data.get('name'), category: data.get('category'), description: data.get('description').trim(),
        aliases: data.get('aliases').split(',').map((a) => a.trim()).filter(Boolean),
        zone: this.draft.zone?.length >= 3 ? this.draft.zone : undefined,
      });
      toast(`Saved “${saved.name}”`, 'success');
      this.draft = null; this.drawing = false;
      this.#emitZone();
      this.render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  render() {
    if (!this.open) return;
    const d = this.draft;
    const head = el('div', { class: 'editor__head' },
      el('h2', { text: 'Edit points of interest' }),
      el('button', { class: 'icon-btn', type: 'button', title: 'Close editor', text: '×', onclick: () => this.toggle(false) }));

    let body;
    if (d) {
      const form = el('form', { class: 'editor__form', onsubmit: (e) => { e.preventDefault(); this.#save(form); } },
        el('label', {}, el('span', { text: 'Name' }), el('input', { name: 'name', required: true, maxlength: '60', value: d.name, placeholder: 'e.g. Meeting Room A' })),
        el('label', {}, el('span', { text: 'Category' }),
          el('select', { name: 'category' }, ...Object.entries(CATEGORIES).map(([key, c]) => el('option', { value: key, selected: key === d.category, text: `${c.icon}  ${c.label}` })))),
        el('label', {}, el('span', { text: 'Also known as' }), el('input', { name: 'aliases', value: (d.aliases ?? []).join(', '), placeholder: 'comma-separated search words' })),
        el('label', {}, el('span', { text: 'Description' }), el('textarea', { name: 'description', rows: '2', maxlength: '200', text: d.description ?? '' })),
        el('div', { class: 'editor__zone' },
          el('span', { text: d.zone?.length >= 3 ? `Zone: ${d.zone.length} corners · ${polygonArea(d.zone).toFixed(1)} m²` : this.drawing ? `Click the floor to add corners (${d.zone?.length ?? 0} so far)` : 'No zone — this is a point' }),
          el('button', { class: 'btn btn--small', type: 'button', text: this.drawing ? 'Finish zone' : d.zone ? 'Redraw zone' : 'Draw zone',
            onclick: () => { this.drawing = !this.drawing; if (this.drawing) d.zone = []; this.#emitZone(); this.render(); } }),
          d.zone && !this.drawing ? el('button', { class: 'btn btn--small btn--ghost', type: 'button', text: 'Remove zone', onclick: () => { delete d.zone; this.#emitZone(); this.render(); } }) : null),
        el('div', { class: 'editor__actions' },
          el('button', { class: 'btn btn--primary', type: 'submit', text: d.id ? 'Save changes' : 'Add POI' }),
          el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => { this.draft = null; this.drawing = false; this.#emitZone(); this.render(); } }),
          d.id ? el('button', { class: 'btn btn--danger', type: 'button', text: 'Delete', onclick: () => { this.store.remove(d.id); this.draft = null; this.#emitZone(); toast('POI deleted'); this.render(); } }) : null));
      body = form;
    } else {
      const todo = this.#unlabelled();
      body = el('div', { class: 'editor__list' },
        el('p', { class: 'editor__hint', text: 'Click anywhere in the 3D view to tag it, or click a label to edit it.' }),
        todo.length ? el('h3', { text: `Detected, not yet named (${todo.length})` }) : null,
        ...todo.slice(0, 8).map((s) => el('button', { class: 'editor__row', type: 'button', onclick: () => this.dispatchEvent(new CustomEvent('suggestion', { detail: s })) },
          el('b', { text: s.kind === 'zone' ? 'Open area' : 'Object' }),
          el('small', { text: s.kind === 'zone' ? `about ${(s.radius_m * 2).toFixed(1)} m across` : `${s.hint} · ${s.size_m[0]}×${s.size_m[1]} m, ${s.height_m} m tall` }))),
        el('h3', { text: `Tagged (${this.store.pois.length})` }),
        ...this.store.pois.map((p) => el('button', { class: 'editor__row', type: 'button', onclick: () => { this.edit(p); this.dispatchEvent(new CustomEvent('focus', { detail: p })); } },
          el('b', { text: p.name }), el('small', { text: `${CATEGORIES[p.category]?.label ?? p.category}${p.zone ? ' · zone' : ''}` }))));
    }

    const foot = el('div', { class: 'editor__foot' },
      el('button', { class: 'btn btn--small', type: 'button', text: 'Export pois.json', onclick: () => this.#download() }),
      this.store.hasDraft ? el('button', { class: 'btn btn--small btn--ghost', type: 'button', text: 'Discard local edits', onclick: () => { this.store.discardDraft(); toast('Restored the published POIs'); } }) : null,
      el('small', { text: this.store.hasDraft ? 'Edits are saved in this browser until exported.' : 'Showing the published POIs.' }));
    this.root.replaceChildren(head, body, foot);
  }

  #download() {
    const url = URL.createObjectURL(new Blob([this.store.export()], { type: 'application/json' }));
    el('a', { href: url, download: 'pois.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${this.store.pois.length} POIs — commit it to app/scenes/${this.store.sceneId}/pois.json`, 'success', 5000);
  }
}
