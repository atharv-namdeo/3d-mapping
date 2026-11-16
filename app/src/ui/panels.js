/** Place card (selected POI / dropped pin) and the turn-by-turn guidance HUD. */
import { categoryOf } from '../core/categories.js';
import { $, el, formatDistance, formatDuration } from './dom.js';

export class PlaceCard extends EventTarget {
  constructor() {
    super();
    this.root = $('#card');
    this.place = null;
  }

  /**
   * @param {object} place  a POI, or { name, position, pin: true } for a dropped pin
   * @param {object} info   { distance, duration, zoneName, inTrip, tripCount }
   */
  show(place, info) {
    this.place = place;
    const cat = place.pin ? { label: 'Dropped pin', icon: '⌖', color: '#ff5d73' } : categoryOf(place);
    const act = (type) => () => this.dispatchEvent(new CustomEvent(type, { detail: place }));
    const reachable = Number.isFinite(info.distance);
    const parts = [
      el('button', { class: 'icon-btn card__close', type: 'button', title: 'Close', text: '×', onclick: act('close') }),
      el('div', { class: 'card__head' },
        el('span', { class: 'card__icon', style: `--pin:${cat.color}`, text: cat.icon }),
        el('div', {},
          el('h2', { text: place.name }),
          el('p', { class: 'card__kind', text: [cat.label, info.zoneName && info.zoneName !== place.name ? `in ${info.zoneName}` : null].filter(Boolean).join(' · ') }))),
      place.description ? el('p', { class: 'card__desc', text: place.description }) : null,
      el('div', { class: 'card__stats' },
        el('div', {}, el('b', { text: formatDistance(info.distance) }), el('small', { text: 'walking distance' })),
        el('div', {}, el('b', { text: reachable ? formatDuration(info.duration) : '—' }), el('small', { text: 'at walking pace' })),
        place.zone ? el('div', {}, el('b', { text: `${info.zoneArea.toFixed(1)} m²` }), el('small', { text: 'zone area' })) : null),
      el('div', { class: 'card__actions' },
        el('button', { class: 'btn btn--primary', type: 'button', disabled: !reachable, text: 'Directions', onclick: act('go') }),
        el('button', { class: 'btn', type: 'button', disabled: !reachable, text: 'Jump there', onclick: act('jump') }),
        place.pin ? null : el('button', { class: 'btn', type: 'button', disabled: !reachable, text: info.inTrip ? 'Remove stop' : 'Add stop', onclick: act('trip') }),
        place.pin ? null : el('button', { class: 'btn btn--ghost', type: 'button', text: 'Copy link', onclick: act('share') })),
      info.tripCount > 1 ? el('button', { class: 'btn btn--trip', type: 'button', text: `Start trip · ${info.tripCount} stops, best order`, onclick: act('starttrip') }) : null,
    ];
    this.root.replaceChildren(...parts.filter(Boolean));
    this.root.hidden = false;
  }

  hide() { this.root.hidden = true; this.place = null; }
}

const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 13h5v8h5v-8h5z"/></svg>';
const FLAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-7.1 7-12a7 7 0 1 0-14 0c0 4.900 7 12 7 12z"/><circle cx="12" cy="10" r="2.6" fill="#0b0d12"/></svg>';

export class GuidanceHud {
  constructor() {
    this.root = $('#hud');
    this.icon = $('#hud-icon');
    this.autoBtn = $('#hud-auto');
  }

  show(stop, remainingStops) {
    this.root.hidden = false;
    $('#hud-dest').textContent = remainingStops > 0 ? `to ${stop.name} · then ${remainingStops} more` : `to ${stop.name}`;
  }

  hide() { this.root.hidden = true; }

  /**
   * @param {object} state  Navigator progress state
   * @param {number} bearing  direction of the route ahead relative to where the visitor looks (rad, + = left)
   */
  update(state, bearing, autopilot) {
    const arriving = state.next.icon === 'arrive';
    const soon = state.distanceToNext < 0.6;
    $('#hud-text').textContent = arriving
      ? (state.remaining < 1.5 ? `${state.stop.name} is right here` : `Continue to ${state.stop.name}`)
      : (soon ? state.next.text : `In ${formatDistance(state.distanceToNext)} — ${state.next.text[0].toLowerCase()}${state.next.text.slice(1)}`);
    $('#hud-distance').textContent = formatDistance(state.remaining);
    $('#hud-eta').textContent = formatDuration(state.eta);
    $('#hud-progress').style.width = `${(state.fraction * 100).toFixed(1)}%`;
    const flag = arriving && state.remaining < 1.5;
    if (this.icon.dataset.kind !== (flag ? 'flag' : 'arrow')) {
      this.icon.dataset.kind = flag ? 'flag' : 'arrow';
      this.icon.innerHTML = flag ? FLAG : ARROW;   // static, trusted markup
    }
    this.icon.style.transform = flag ? '' : `rotate(${(-bearing * 180 / Math.PI).toFixed(1)}deg)`;
    this.autoBtn.textContent = autopilot ? 'Take over' : 'Auto-walk';
    this.autoBtn.classList.toggle('is-on', autopilot);
  }
}
