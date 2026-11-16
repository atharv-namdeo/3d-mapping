/**
 * SearchUI — the search box and its result list.
 *
 * Results update on every keystroke and are ranked by text match and walking distance.
 * Moving through them (arrow keys or hover) previews the place live in the 3D view.
 *   Enter → directions · Shift+Enter → jump there · Esc → close
 */
import { categoryOf } from '../core/categories.js';
import { $, el, formatDistance, formatDuration } from './dom.js';

export class SearchUI extends EventTarget {
  /**
   * @param {object} deps
   * @param {() => object[]} deps.search   (text) => ranked results
   * @param {number} deps.walkSpeed
   */
  constructor({ search, walkSpeed }) {
    super();
    this.search = search;
    this.walkSpeed = walkSpeed;
    this.input = $('#search-input');
    this.list = $('#search-results');
    this.results = [];
    this.cursor = -1;

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('focus', () => this.refresh());
    this.input.addEventListener('keydown', (e) => this.#onKey(e));
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.search')) this.close(); });
    this.#setupVoice();
  }

  focus() { this.input.focus(); this.input.select(); }

  close() {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.cursor = -1;
  }

  refresh() {
    this.results = this.search(this.input.value);
    this.cursor = this.results.length && this.input.value.trim() ? 0 : -1;
    this.#render();
    if (this.cursor >= 0) this.#emit('preview', this.results[this.cursor].poi);
  }

  #emit(type, poi) { this.dispatchEvent(new CustomEvent(type, { detail: poi })); }

  #render() {
    const rows = this.results.map((r, k) => {
      const cat = categoryOf(r.poi);
      const reachable = Number.isFinite(r.distance);
      const row = el('li', { class: `result${k === this.cursor ? ' is-active' : ''}`, role: 'option', id: `result-${k}`, 'aria-selected': String(k === this.cursor) },
        el('span', { class: 'result__icon', style: `--pin:${cat.color}`, text: cat.icon }),
        el('span', { class: 'result__main' },
          el('b', { text: r.poi.name }),
          el('small', { text: r.matched === 'alias' ? `${cat.label} · also known as “${this.#matchedAlias(r.poi)}”` : cat.label })),
        el('span', { class: 'result__dist' },
          el('b', { text: formatDistance(r.distance) }),
          el('small', { text: reachable ? `${formatDuration(r.distance / this.walkSpeed)} walk` : 'unreachable' })),
        el('button', { class: 'result__jump', type: 'button', title: 'Jump there (Shift+Enter)', text: 'Jump', onclick: (e) => { e.stopPropagation(); this.#choose(k, true); } }));
      row.addEventListener('pointerenter', () => { if (this.cursor !== k) { this.cursor = k; this.#highlight(); this.#emit('preview', r.poi); } });
      row.addEventListener('click', () => this.#choose(k, false));
      return row;
    });
    if (!rows.length) rows.push(el('li', { class: 'result result--empty', text: this.input.value.trim() ? 'Nothing here matches — try another word, or add it in “Edit POIs”.' : 'No places tagged yet.' }));
    else if (!this.input.value.trim()) rows.unshift(el('li', { class: 'result result--heading', text: 'Nearest to you' }));
    this.list.replaceChildren(...rows);
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  #matchedAlias(poi) {
    const q = this.input.value.toLowerCase();
    return (poi.aliases ?? []).find((a) => q.split(/\s+/).some((w) => w.length > 1 && a.toLowerCase().includes(w))) ?? poi.aliases?.[0] ?? poi.name;
  }

  #highlight() {
    this.list.querySelectorAll('.result[role=option]').forEach((row, k) => {
      row.classList.toggle('is-active', k === this.cursor);
      row.setAttribute('aria-selected', String(k === this.cursor));
      if (k === this.cursor) { row.scrollIntoView({ block: 'nearest' }); this.input.setAttribute('aria-activedescendant', row.id); }
    });
  }

  #choose(k, jump) {
    const result = this.results[k];
    if (!result) return;
    this.input.value = result.poi.name;
    this.close();
    this.input.blur();
    this.#emit(jump ? 'jump' : 'go', result.poi);
  }

  #onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!this.results.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.cursor = (this.cursor + step + this.results.length) % this.results.length;
      this.#highlight();
      this.#emit('preview', this.results[this.cursor].poi);
      e.preventDefault();
    } else if (e.key === 'Enter') {
      this.#choose(Math.max(0, this.cursor), e.shiftKey);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      this.close();
      this.input.blur();
      e.stopPropagation();
    }
  }

  #setupVoice() {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const button = $('#voice-btn');
    if (!Recognition) return;
    button.hidden = false;
    button.addEventListener('click', () => {
      const rec = new Recognition();
      rec.lang = navigator.language || 'en-IN';
      rec.maxAlternatives = 1;
      button.classList.add('is-listening');
      rec.onresult = (e) => { this.input.value = e.results[0][0].transcript; this.refresh(); if (this.results.length) this.#choose(0, false); };
      rec.onend = rec.onerror = () => button.classList.remove('is-listening');
      rec.start();
    });
  }
}
