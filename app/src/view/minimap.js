/**
 * Minimap — the automatically generated floor plan with the visitor's position,
 * heading, POIs and the active route. Click anywhere on it to be routed there.
 */
import { categoryOf } from '../core/categories.js';

export class Minimap extends EventTarget {
  constructor(canvas, grid, floorplanUrl) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.grid = grid;
    this.image = new Image();
    this.image.src = floorplanUrl;
    this.image.onload = () => { this.dirty = true; };
    this.pois = [];
    this.route = null;
    this.selectedId = null;
    this.showNav = false;
    this.view = this.#fitToWalkable();

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const [x, z] = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
      this.dispatchEvent(new CustomEvent('pick', { detail: { x, z } }));
    });
    new ResizeObserver(() => this.#resize()).observe(canvas);
    this.#resize();
  }

  /** World rectangle to display: the walkable area plus some context around it. */
  #fitToWalkable() {
    const g = this.grid;
    let minI = g.width, maxI = 0, minJ = g.height, maxJ = 0;
    for (let j = 0; j < g.height; j++) for (let i = 0; i < g.width; i++) {
      if (!g.walkable[j * g.width + i]) continue;
      minI = Math.min(minI, i); maxI = Math.max(maxI, i); minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j);
    }
    const pad = 1.0;
    return {
      minX: g.x0 + minI * g.res - pad, maxX: g.x0 + (maxI + 1) * g.res + pad,
      minZ: g.z0 + minJ * g.res - pad, maxZ: g.z0 + (maxJ + 1) * g.res + pad,
    };
  }

  #resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    // Uniform scale that fits the view rectangle, centred.
    const v = this.view;
    this.scale = Math.min(w / (v.maxX - v.minX), h / (v.maxZ - v.minZ));
    this.offX = (w - (v.maxX - v.minX) * this.scale) / 2;
    this.offY = (h - (v.maxZ - v.minZ) * this.scale) / 2;
  }

  toScreen(x, z) { return [this.offX + (x - this.view.minX) * this.scale, this.offY + (z - this.view.minZ) * this.scale]; }
  toWorld(px, py) { return [this.view.minX + (px - this.offX) / this.scale, this.view.minZ + (py - this.offY) / this.scale]; }

  draw(player, time) {
    const { ctx, grid } = this;
    if (!this.scale) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const b = grid.bounds;
    const [ix, iy] = this.toScreen(b.minX, b.minZ);
    const iw = (b.maxX - b.minX) * this.scale, ih = (b.maxZ - b.minZ) * this.scale;
    if (this.image.complete && this.image.naturalWidth) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.image, ix, iy, iw, ih);
      ctx.globalAlpha = 1;
    }
    if (this.showNav) {
      if (!this.navLayer) this.navLayer = this.#renderNavLayer();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.navLayer, ix, iy, iw, ih);
      ctx.imageSmoothingEnabled = true;
    }

    if (this.route) {
      ctx.lineJoin = ctx.lineCap = 'round';
      const trace = () => { ctx.beginPath(); this.route.forEach(([x, z], k) => { const [px, py] = this.toScreen(x, z); k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); };
      trace(); ctx.strokeStyle = 'rgba(10, 20, 40, 0.85)'; ctx.lineWidth = 6; ctx.stroke();
      trace(); ctx.strokeStyle = '#4d9bff'; ctx.lineWidth = 3.5; ctx.stroke();
      ctx.setLineDash([2, 9]); ctx.lineDashOffset = -time * 14;
      trace(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.setLineDash([]);
      const [gx, gy] = this.toScreen(...this.route[this.route.length - 1]);
      ctx.beginPath(); ctx.arc(gx, gy, 5 + 1.5 * Math.sin(time * 3), 0, Math.PI * 2);
      ctx.fillStyle = '#ff5d73'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    }

    for (const poi of this.pois) {
      const [px, py] = this.toScreen(poi.position[0], poi.position[2]);
      const selected = poi.id === this.selectedId;
      ctx.beginPath(); ctx.arc(px, py, selected ? 5.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = categoryOf(poi).color; ctx.fill();
      ctx.lineWidth = selected ? 2 : 1; ctx.strokeStyle = selected ? '#fff' : 'rgba(8, 12, 20, 0.9)'; ctx.stroke();
    }

    // Visitor: view cone + arrow.
    const [px, py] = this.toScreen(player.x, player.z);
    const [fx, fz] = player.forward;
    const ang = Math.atan2(fz, fx);
    const cone = ctx.createRadialGradient(px, py, 0, px, py, 46);
    cone.addColorStop(0, 'rgba(77, 155, 255, 0.5)'); cone.addColorStop(1, 'rgba(77, 155, 255, 0)');
    ctx.beginPath(); ctx.moveTo(px, py); ctx.arc(px, py, 46, ang - 0.55, ang + 0.55); ctx.closePath(); ctx.fillStyle = cone; ctx.fill();
    ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, 5); ctx.lineTo(-2.5, 0); ctx.lineTo(-5, -5); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1d4ed8'; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
    ctx.restore();

    // Scale bar (1 m) so distances on the plan mean something.
    const bar = this.scale;
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(10, h - 12, bar, 2);
    ctx.font = '10px system-ui, sans-serif'; ctx.fillText('1 m', 10, h - 16);
  }

  #renderNavLayer() {
    const g = this.grid;
    const c = document.createElement('canvas');
    c.width = g.width; c.height = g.height;
    const img = c.getContext('2d').createImageData(g.width, g.height);
    for (let k = 0; k < g.walkable.length; k++) {
      if (!g.walkable[k]) continue;
      const tight = 1 - Math.min(1, g.clearance[k] / 0.5);
      img.data.set([40 + 215 * tight, 220 - 60 * tight, 130 - 90 * tight, 120], k * 4);
    }
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }
}
