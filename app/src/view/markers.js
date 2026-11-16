/**
 * Markers — POI labels that live in the 3D view as DOM elements (crisp text, real
 * buttons, keyboard and screen-reader accessible), plus floor outlines for zones.
 */
import * as THREE from 'three';
import { categoryOf } from '../core/categories.js';
import { RENDER_ORDER } from './viewer.js';

const MAX_LABEL_DISTANCE = 14;

export class Markers extends EventTarget {
  constructor(viewer, grid, layer) {
    super();
    this.viewer = viewer;
    this.grid = grid;
    this.layer = layer;
    this.items = new Map();          // poi.id -> { poi, el }
    this.selectedId = null;
    this.zoneGroup = new THREE.Group();
    viewer.scene.add(this.zoneGroup);
    this.screen = {};
  }

  /** Rebuild all labels (called whenever the POI set changes). */
  setPois(pois) {
    this.layer.replaceChildren();
    this.items.clear();
    for (const poi of pois) {
      const cat = categoryOf(poi);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'poi-pin';
      el.style.setProperty('--pin', cat.color);
      el.setAttribute('aria-label', `${poi.name} — ${cat.label}`);
      const icon = document.createElement('span');
      icon.className = 'poi-pin__icon';
      icon.textContent = cat.icon;
      const name = document.createElement('span');
      name.className = 'poi-pin__name';
      name.textContent = poi.name;
      el.append(icon, name);
      el.addEventListener('click', (e) => { e.stopPropagation(); this.dispatchEvent(new CustomEvent('select', { detail: poi })); });
      this.layer.appendChild(el);
      this.items.set(poi.id, { poi, el });
    }
    this.select(this.selectedId && this.items.has(this.selectedId) ? this.selectedId : null);
  }

  /** Highlight one POI and, if it is a zone, outline it on the floor. */
  select(id) {
    this.selectedId = id;
    for (const { poi, el } of this.items.values()) el.classList.toggle('is-selected', poi.id === id);
    this.showZone(id ? this.items.get(id)?.poi.zone : null, id ? categoryOf(this.items.get(id).poi).color : null);
  }

  /** Draw a floor polygon (also used live by the editor while a zone is being drawn). */
  showZone(zone, color = '#7c9cff') {
    for (const child of [...this.zoneGroup.children]) { child.geometry.dispose(); child.material.dispose(); this.zoneGroup.remove(child); }
    if (!zone || zone.length < 2) return;
    const outline = new THREE.BufferGeometry().setFromPoints(zone.map(([x, z]) => new THREE.Vector3(x, 0.04, z)));
    const line = new THREE.LineLoop(outline, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    line.renderOrder = RENDER_ORDER.beacon;
    this.zoneGroup.add(line);
    if (zone.length >= 3) {
      const shape = new THREE.Shape(zone.map(([x, z]) => new THREE.Vector2(x, -z)));
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      fill.position.y = 0.02;
      fill.renderOrder = RENDER_ORDER.navOverlay;
      this.zoneGroup.add(fill);
    }
  }

  /** Reposition labels for the current camera; called once per frame. */
  update() {
    const cam = this.viewer.camera.position;
    const shown = [];
    for (const item of this.items.values()) {
      const { poi, el } = item;
      const [x, y, z] = poi.position;
      const s = this.viewer.project(x, y, z, this.screen);
      const distance = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
      const selected = poi.id === this.selectedId;
      if (!s.visible || (distance > MAX_LABEL_DISTANCE && !selected)) { el.hidden = true; continue; }
      el.hidden = false;
      // Is something solid between the eye and the label? Then fade it rather than hide it.
      const dir = [(x - cam.x) / distance, (y - cam.y) / distance, (z - cam.z) / distance];
      const hit = this.grid.raycast([cam.x, cam.y, cam.z], dir, distance);
      const occluded = Boolean(hit && !hit.onFloor && hit.distance < distance - 0.5);
      const scale = Math.max(0.72, Math.min(1.1, 2.6 / Math.max(distance, 0.5) + 0.55));
      el.style.transform = `translate(-50%, -100%) translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      el.style.zIndex = String(selected ? 100000 : Math.round(10000 - distance * 100));
      el.classList.toggle('is-occluded', occluded && !selected);
      item.width ??= el.offsetWidth;   // full label width, measured once
      shown.push({ el, x: s.x, y: s.y, half: (item.width * scale) / 2, tall: 30 * scale, rank: (selected ? -1000 : 0) + (occluded ? 50 : 0) + distance, far: distance > 7 && !selected });
    }
    // Declutter: nearer / selected labels keep their text, overlapped ones collapse to an icon.
    shown.sort((a, b) => a.rank - b.rank);
    const kept = [];
    for (const label of shown) {
      const clash = label.far || kept.some((k) => Math.abs(k.x - label.x) < k.half + label.half + 4 && Math.abs(k.y - label.y) < Math.max(k.tall, label.tall));
      label.el.classList.toggle('is-far', clash);
      if (!clash) kept.push(label);
    }
  }
}
