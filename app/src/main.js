/**
 * Namma Space — Indoor Navigator (Round 2).
 * Wires the scene data, the navigation core, the 3D view and the UI together.
 *
 * URL parameters
 *   scene=<id>             which scene to open (default: first in scenes/index.json)
 *   poi=<id>               open with this place selected and routed to
 *   jump=1                 …and jump straight to it
 *   quality=auto|full|lite|off  splat detail (default: lite on phones; elsewhere lite first,
 *                          upgraded to full when the device renders it smoothly)
 *   style=points|surfaces  how to draw the capture when a scene offers both
 *   capture=1              do not self-animate; an external script drives step(dt)
 */
import { NavGrid } from './core/navgrid.js';
import { PoiStore } from './core/poi-store.js';
import { Navigator } from './core/navigator.js';
import { WALKER } from './core/pathfinder.js';
import { pointAlong, projectOnRoute } from './core/guidance.js';
import { polygonArea } from './core/spatial-index.js';
import { Viewer, EYE_HEIGHT } from './view/viewer.js';
import { Player } from './view/player.js';
import { Director } from './view/director.js';
import { PathVisual } from './view/path-visual.js';
import { Markers } from './view/markers.js';
import { Minimap } from './view/minimap.js';
import { SearchUI } from './ui/search-ui.js';
import { PlaceCard, GuidanceHud } from './ui/panels.js';
import { Editor } from './ui/editor.js';
import { $, toast } from './ui/dom.js';

const params = new URLSearchParams(location.search);
const fetchJSON = async (url, fallback) => {
  const res = await fetch(url);
  if (!res.ok) { if (fallback !== undefined) return fallback; throw new Error(`${url}: HTTP ${res.status}`); }
  return res.json();
};

function safeStorage() {
  try { localStorage.setItem('namma-space:probe', '1'); localStorage.removeItem('namma-space:probe'); return localStorage; } catch { return null; }
}

/** The most open spot on the floor — a sensible place to start if the scene does not name one. */
function roomiestSpot(grid) {
  let best = 0;
  for (let k = 1; k < grid.clearance.length; k++) if (grid.clearance[k] > grid.clearance[best]) best = k;
  return grid.centerOf(best % grid.width, Math.floor(best / grid.width));
}

class App {
  async start() {
    const index = await fetchJSON('scenes/index.json');
    const sceneId = index.scenes.some((s) => s.id === params.get('scene')) ? params.get('scene') : index.scenes[0].id;
    const base = `scenes/${sceneId}/`;
    const [scene, nav, pois, suggestions] = await Promise.all([
      fetchJSON(`${base}scene.json`), fetchJSON(`${base}nav.json`), fetchJSON(`${base}pois.json`, []), fetchJSON(`${base}suggestions.json`, []),
    ]);
    this.scene = scene;
    this.sceneId = sceneId;
    document.title = `${scene.name} — Namma Space`;
    const picker = $('#scene-picker');
    picker.replaceChildren(...index.scenes.map((s) => Object.assign(document.createElement('option'), { value: s.id, textContent: s.name, selected: s.id === sceneId })));
    picker.addEventListener('change', () => { location.search = new URLSearchParams({ scene: picker.value }).toString(); });
    $('#loading-title').textContent = scene.name;

    this.grid = NavGrid.fromJSON(nav);
    this.store = new PoiStore(sceneId, pois, safeStorage());
    this.navigator = new Navigator(this.grid, this.store);
    this.viewer = new Viewer($('#stage'));
    this.viewer.buildDerived(this.grid, base + nav.assets.floorplan);
    this.player = new Player(this.viewer, this.grid);
    this.director = new Director(this.player);
    this.path = new PathVisual(this.viewer.scene);
    this.markers = new Markers(this.viewer, this.grid, $('#pins'));
    this.minimap = new Minimap($('#map-canvas'), this.grid, base + nav.assets.floorplan);
    this.card = new PlaceCard();
    this.hud = new GuidanceHud();
    this.editor = new Editor(this.store, suggestions);
    this.searchUI = new SearchUI({ search: (text) => this.search(text), walkSpeed: WALKER.standard.speed });
    this.trip = [];
    this.selected = null;

    const spawn = scene.spawn ?? {};
    const [sx, sz] = spawn.position ?? roomiestSpot(this.grid);
    this.player.place(sx, sz, ((spawn.yawDeg ?? 0) * Math.PI) / 180);

    this.#wire();
    this.#syncPois();
    this.#loop();
    this.#loadVisual(base, nav.assets);
    this.#openDeepLink();
  }

  /**
   * The space is usable straight away in blueprint view while the scan streams in:
   *   1. the light version (phones' level) loads first, so the real scan appears quickly;
   *   2. on a computer that renders it smoothly, the full-detail version then loads in the
   *      background and replaces it.
   * Progress stays visible the whole time, and a failure never blocks navigation.
   */
  #loadVisual(base, assets) {
    const phone = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
    const quality = params.get('quality') ?? (phone ? 'lite' : 'auto');
    const pill = $('#scan-status');
    const status = (text) => { pill.hidden = !text; pill.textContent = text ?? ''; };
    this.setMode('blueprint');
    $('#btn-mode').disabled = true;
    $('#loading').classList.add('is-done');
    setTimeout(() => { $('#loading').hidden = true; }, 500);
    if (quality === 'off') return;

    const styles = Viewer.stylesOf(assets);
    const wanted = params.get('style') ?? this.scene.view?.defaultStyle ?? styles[0];
    const style = styles.includes(wanted) ? wanted : styles[0];
    this.styleState = { base, assets, quality, styles };
    $('#btn-style').hidden = styles.length < 2;
    const hasLite = Boolean(assets.splat && assets.splatLite);
    const firstLite = style === 'surfaces' && hasLite && quality !== 'full';
    const label = firstLite ? 'Loading the 3D scan' : 'Loading the 3D scan (full detail)';
    status(`${label}…`);
    const started = performance.now();
    const progress = (f) => {
      const slow = performance.now() - started > 45000 ? ' — slow connection, you can keep using the map' : '';
      status(f < 1 ? `${label}… ${Math.round(f * 100)}%${slow}` : 'Preparing the 3D scan…');
    };
    this.viewer.loadPhotoreal(base, assets, { style, lite: firstLite, pointSize: this.scene.view?.pointSize, onProgress: progress })
      .then(() => {
        status(null);
        $('#btn-mode').disabled = !this.viewer.photoreal;
        this.#syncStyleButton();
        this.setMode(this.scene.view?.defaultMode === 'blueprint' ? 'blueprint' : 'photoreal');
        if (firstLite && quality === 'auto') this.#maybeUpgrade(base, assets);
      })
      .catch((err) => {
        console.error(err);
        status(null);
        toast('The 3D scan could not be loaded on this device — showing the blueprint instead.', 'error', 10000);
      });
  }

  #syncStyleButton() {
    // A trained splat is the real photoreal capture; generated surfels are only smoothed points.
    const surfaces = this.styleState?.assets?.trained ? 'Photoreal' : 'Surfaces';
    $('#btn-style').textContent = this.viewer.style === 'points' ? surfaces : 'Points';
  }

  /** Switch between the sharp point view and the smooth surface view (downloaded on first use). */
  async toggleStyle() {
    const s = this.styleState;
    if (!s || s.styles.length < 2 || this.switchingStyle) return;
    const next = this.viewer.style === 'points' ? 'surfaces' : 'points';
    const pill = $('#scan-status');
    this.switchingStyle = true;
    try {
      const firstTime = !this.viewer.styles?.[next];
      await this.viewer.loadPhotoreal(s.base, s.assets, {
        style: next, lite: next === 'surfaces' && s.quality !== 'full', pointSize: this.scene.view?.pointSize,
        onProgress: (f) => {
          const name = next === 'points' ? 'points' : (s.assets.trained ? 'photoreal view' : 'surfaces');
          pill.hidden = false; pill.textContent = f < 1 ? `Loading ${name}… ${Math.round(f * 100)}%` : `Preparing ${name}…`;
        },
      });
      pill.hidden = true;
      this.setMode('photoreal');
      this.#syncStyleButton();
      if (firstTime && next === 'surfaces' && s.quality === 'auto') this.#maybeUpgrade(s.base, s.assets);
    } catch (err) {
      console.error(err);
      pill.hidden = true;
      toast(`The ${next} view could not be loaded on this device.`, 'error', 6000);
    } finally {
      this.switchingStyle = false;
    }
  }

  /** Load full detail only if the light version runs smoothly (≥ 40 fps over a few seconds). */
  #maybeUpgrade(base, assets) {
    let frames = 0;
    const t0 = performance.now();
    const count = () => {
      frames++;
      if (performance.now() - t0 < 4000) { requestAnimationFrame(count); return; }
      const fps = (frames * 1000) / (performance.now() - t0);
      if (fps < 40 || document.hidden) return;
      const pill = $('#scan-status');
      pill.hidden = false;
      this.viewer.upgradePhotoreal(base, assets, {
        onProgress: (f) => { pill.textContent = f < 1 ? `Loading full detail… ${Math.round(f * 100)}%` : 'Preparing full detail…'; },
      }).then(() => { pill.hidden = true; }, (err) => { console.warn('full detail unavailable', err); pill.hidden = true; });
    };
    requestAnimationFrame(count);
  }

  // ───────────────────────────── queries ─────────────────────────────

  search(text) {
    const here = this.player.position;
    return this.store.search.query(text, { distanceTo: (poi) => this.navigator.walkingDistance(here, poi), limit: 8 });
  }

  /**
   * Where to stand to look at a place: a free spot 1–2 m away with a clear line of
   * sight, as close as possible to the direction the visitor would arrive from.
   */
  viewpointFor(place) {
    const [x, , z] = place.position;
    const { grid } = this;
    let best = null;
    for (const radius of [1.3, 1.0, 1.7, 0.7, 2.2]) {
      for (let a = 0; a < 16; a++) {
        const cx = x + Math.cos((a / 16) * 2 * Math.PI) * radius, cz = z + Math.sin((a / 16) * 2 * Math.PI) * radius;
        if (!grid.isFree(cx, cz, 0.25)) continue;
        const d = Math.hypot(x - cx, z - cz);
        const hit = grid.raycast([cx, EYE_HEIGHT, cz], [(x - cx) / d, (place.position[1] - EYE_HEIGHT) / d, (z - cz) / d], d);
        const blocked = hit && !hit.onFloor && hit.distance < d - 0.45;
        const score = (blocked ? 5 : 0) + Math.hypot(cx - this.player.x, cz - this.player.z) * 0.15 + Math.abs(radius - 1.3);
        if (!best || score < best.score) best = { x: cx, z: cz, score };
      }
      if (best && best.score < 2) break;
    }
    const spot = best ?? (() => { const s = grid.nearestFree(x, z, 0.25) ?? [x, z]; return { x: s[0], z: s[1] }; })();
    return { ...spot, yaw: Player.yawTowards(spot.x, spot.z, x, z) };
  }

  // ───────────────────────────── actions ─────────────────────────────

  select(place, { preview = true } = {}) {
    this.selected = place;
    this.markers.select(place.pin ? null : place.id);
    this.minimap.selectedId = place.pin ? null : place.id;
    const route = this.navigator.preview(this.player.position, [place.position[0], place.position[2]]);
    const zone = this.store.spatial.zonesAt(place.position[0], place.position[2])[0];
    this.card.show(place, {
      distance: route?.length ?? Infinity, duration: route?.duration ?? Infinity, zoneName: zone?.name,
      zoneArea: place.zone ? polygonArea(place.zone) : 0, inTrip: this.trip.includes(place), tripCount: this.trip.length,
    });
    if (preview && !this.navigator.active) this.#showRoute(route?.points ?? null, 0.5);
  }

  deselect() {
    this.selected = null;
    this.markers.select(null);
    this.minimap.selectedId = null;
    this.card.hide();
    if (!this.navigator.active) this.#showRoute(null);
  }

  go(place) {
    this.director.cancel();
    const stop = place.pin ? { name: place.name, target: [place.position[0], place.position[2]] } : place;
    if (this.navigator.navigateTo(this.player.position, stop)) this.select(place, { preview: false });
  }

  async jump(place) {
    this.select(place, { preview: false });
    const view = this.viewpointFor(place);
    document.body.classList.add('is-flying');
    const landed = await this.director.flyTo(view.x, view.z, view.yaw);
    document.body.classList.remove('is-flying');
    if (landed && this.selected === place) { this.select(place, { preview: false }); if (!this.navigator.active) this.#showRoute(null); }
  }

  toggleTrip(place) {
    this.trip = this.trip.includes(place) ? this.trip.filter((p) => p !== place) : [...this.trip, place];
    toast(this.trip.includes(place) ? `Added ${place.name} — ${this.trip.length} stop${this.trip.length > 1 ? 's' : ''} in trip` : `Removed ${place.name}`);
    this.select(place);
  }

  startTrip() {
    this.director.cancel();
    if (this.navigator.navigateTrip(this.player.position, this.trip)) {
      toast(`Trip planned: ${this.navigator.stops.map((s) => s.name).join(' → ')}`, 'success', 5000);
      this.trip = [];
      this.card.hide();
    }
  }

  share(place) {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ scene: this.sceneId, poi: place.id }).toString();
    navigator.clipboard?.writeText(url.href).then(() => toast('Link copied — it opens the space with this route'), () => toast(url.href, 'info', 8000));
  }

  toggleAutopilot() {
    if (this.director.autopilot) { this.director.cancel(); return; }
    if (!this.navigator.active) return;
    const { along } = projectOnRoute(this.navigator.route.points, this.player.x, this.player.z);
    this.director.follow(this.navigator.route, { speed: 1.6, startAlong: along });
  }

  setMode(mode) {
    this.viewer.setMode(mode);
    $('#btn-mode').textContent = this.viewer.mode === 'photoreal' ? 'Blueprint' : 'Photoreal';
    document.body.dataset.mode = this.viewer.mode;
    this.path.setGhostOpacity(this.viewer.mode === 'photoreal' ? 0.28 : 0.6);
  }

  toggleNavOverlay() {
    const on = this.viewer.toggleNavOverlay();
    this.minimap.showNav = on;
    $('#btn-nav').classList.toggle('is-on', on);
  }

  #showRoute(points, opacity = 1) {
    this.path.setRoute(points);
    this.path.uniforms.uOpacity.value = opacity;
    this.minimap.route = points;
  }

  #syncPois() {
    this.markers.setPois(this.store.pois);
    this.minimap.pois = this.store.pois;
  }

  /** Resolve a click in the 3D view (or on the map) to a place and act on it. */
  #pickWorld(hit) {
    const [x, , z] = hit.point;
    const existing = this.store.spatial.resolve(x, z, hit.onFloor ? 0.45 : 0.8);
    if (this.editor.open) {
      // While tagging, clicking inside a room must create a new place in it; only a click
      // right on an existing point (or its label) opens that point for editing.
      const point = this.store.spatial.withinRadius(x, z, hit.onFloor ? 0.45 : 0.8).find(({ poi }) => !poi.zone);
      this.editor.handlePick(hit, point?.poi ?? null);
      return;
    }
    if (existing) { this.select(existing); return; }
    const spot = this.grid.nearestFree(x, z, this.navigator.walker.radius, 2.5);
    if (!spot) { toast('That spot was not mapped as walkable floor.'); return; }
    const zone = this.store.spatial.zonesAt(spot[0], spot[1])[0];
    this.select({ pin: true, name: zone ? `Spot in ${zone.name}` : 'Dropped pin', position: [spot[0], 0.2, spot[1]] });
  }

  #openDeepLink() {
    const poi = this.store.get(params.get('poi') ?? '');
    if (!poi) return;
    if (params.get('jump')) this.jump(poi); else this.go(poi);
  }

  // ───────────────────────────── wiring ─────────────────────────────

  #wire() {
    const { navigator: nav } = this;

    this.player.addEventListener('pick', (e) => {
      const ray = this.viewer.rayThrough(e.detail.clientX, e.detail.clientY);
      const hit = this.grid.raycast(ray.origin, ray.direction, 30);
      if (hit) this.#pickWorld(hit);
    });
    this.player.addEventListener('mouselook', (e) => { $('#crosshair').hidden = !e.detail; });
    this.markers.addEventListener('select', (e) => (this.editor.open ? this.editor.edit(e.detail) : this.select(e.detail)));
    this.minimap.addEventListener('pick', (e) => this.#pickWorld({ point: [e.detail.x, 0, e.detail.z], onFloor: true }));

    this.searchUI.addEventListener('preview', (e) => this.select(e.detail));
    this.searchUI.addEventListener('go', (e) => this.go(e.detail));
    this.searchUI.addEventListener('jump', (e) => this.jump(e.detail));

    this.card.addEventListener('go', (e) => this.go(e.detail));
    this.card.addEventListener('jump', (e) => this.jump(e.detail));
    this.card.addEventListener('trip', (e) => this.toggleTrip(e.detail));
    this.card.addEventListener('starttrip', () => this.startTrip());
    this.card.addEventListener('share', (e) => this.share(e.detail));
    this.card.addEventListener('close', () => this.deselect());

    nav.addEventListener('route', (e) => {
      if (!e.detail) { this.hud.hide(); this.#showRoute(this.selected ? this.navigator.preview(this.player.position, [this.selected.position[0], this.selected.position[2]])?.points ?? null : null, 0.5); this.director.autopilot && this.director.cancel(); return; }
      this.#showRoute(e.detail.route.points, 1);
      this.hud.show(e.detail.stop, e.detail.remainingStops);
    });
    nav.addEventListener('progress', (e) => {
      this.path.setWalked(e.detail.along);
      const ahead = pointAlong(nav.route.points, e.detail.along + 1.2).point;
      const want = Player.yawTowards(this.player.x, this.player.z, ahead[0], ahead[1]);
      let bearing = (want - this.player.yaw) % (2 * Math.PI);
      if (bearing > Math.PI) bearing -= 2 * Math.PI;
      if (bearing < -Math.PI) bearing += 2 * Math.PI;
      this.hud.update(e.detail, bearing, this.director.autopilot);
    });
    nav.addEventListener('arrive', (e) => toast(e.detail.final ? `You have arrived at ${e.detail.stop.name}` : `Reached ${e.detail.stop.name} — on to the next stop`, 'success', 4000));
    nav.addEventListener('unreachable', (e) => toast(`No walkable route to ${e.detail.name}${nav.walker === WALKER.accessible ? ' at step-free width — try the standard profile' : ''}.`, 'error', 5000));

    this.store.addEventListener('change', () => { this.#syncPois(); if (this.selected && !this.selected.pin) { const fresh = this.store.get(this.selected.id); fresh ? this.select(fresh) : this.deselect(); } });
    this.editor.addEventListener('toggle', (e) => {
      $('#btn-edit').classList.toggle('is-on', e.detail);
      document.body.classList.toggle('is-editing', e.detail);
      $('#status-hint').textContent = e.detail ? 'Editing — click the scene to tag a place, or a label to change it' : 'Drag to look · W A S D to walk · click a label or the floor';
      if (e.detail) this.deselect();
    });
    this.editor.addEventListener('zone', (e) => this.markers.showZone(e.detail, '#ffd166'));
    this.editor.addEventListener('focus', (e) => { const v = this.viewpointFor(e.detail); this.director.flyTo(v.x, v.z, v.yaw); });
    this.editor.addEventListener('suggestion', (e) => {
      const s = e.detail;
      const place = { position: [s.position[0], s.height_m ?? 1, s.position[1]] };
      const v = this.viewpointFor(place);
      this.director.flyTo(v.x, v.z, v.yaw);
      this.editor.handlePick({ point: [s.position[0], s.height_m ?? 0, s.position[1]], onFloor: s.kind === 'zone' }, null);
    });

    $('#hud-auto').addEventListener('click', () => this.toggleAutopilot());
    $('#hud-stop').addEventListener('click', () => nav.stop());
    $('#btn-mode').addEventListener('click', () => this.setMode(this.viewer.mode === 'photoreal' ? 'blueprint' : 'photoreal'));
    $('#btn-style').addEventListener('click', () => this.toggleStyle());
    $('#btn-nav').addEventListener('click', () => this.toggleNavOverlay());
    $('#btn-edit').addEventListener('click', () => this.editor.toggle());
    $('#btn-help').addEventListener('click', () => { $('#help').hidden = false; });
    $('#help').addEventListener('click', (e) => { if (e.target.id === 'help' || e.target.closest('[data-close]')) $('#help').hidden = true; });
    $('#map-expand').addEventListener('click', () => $('#map').classList.toggle('is-expanded'));
    $('#opt-accessible').addEventListener('change', (e) => {
      nav.setWalker(e.target.checked ? 'accessible' : 'standard');
      toast(e.target.checked ? 'Routes now keep a 0.76 m clear width' : 'Standard walking routes');
      if (this.selected) this.select(this.selected);
    });

    window.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select');
      if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) { this.searchUI.focus(); e.preventDefault(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.code) {
        case 'KeyG': this.toggleAutopilot(); break;
        case 'KeyM': $('#map').classList.toggle('is-expanded'); break;
        case 'KeyP': this.toggleStyle(); break;
        case 'KeyB': this.setMode(this.viewer.mode === 'photoreal' ? 'blueprint' : 'photoreal'); break;
        case 'KeyV': this.toggleNavOverlay(); break;
        case 'KeyE': this.editor.toggle(); break;
        case 'KeyF': this.player.toggleMouseLook(); break;
        case 'Slash': if (e.shiftKey) $('#help').hidden = !$('#help').hidden; break;
        case 'Escape':
          if (!$('#help').hidden) $('#help').hidden = true;
          else if (this.director.busy) this.director.cancel();
          else if (nav.active) nav.stop();
          else if (this.selected) this.deselect();
          break;
        default: return;
      }
    });
  }

  /** Advance the whole app by `dt` seconds and draw one frame. */
  step(dt) {
    this.clock = (this.clock ?? 0) + dt;
    this.director.update(dt);
    this.player.update(dt);
    this.navigator.update(this.player.position, dt);
    this.path.update(this.clock, this.viewer.camera.position);
    this.viewer.render();
    this.markers.update();
    this.minimap.draw(this.player, this.clock);
  }

  #loop() {
    // ?capture=1 hands the clock to an external driver (scripts/record_demo.cjs), which
    // calls step() once per video frame so recordings are smooth on any machine.
    if (params.has('capture')) return;
    let last = performance.now(), frames = 0, fpsAt = last;
    const tick = (now) => {
      this.step(Math.min(0.1, (now - last) / 1000));
      last = now;
      if (++frames && now - fpsAt >= 1000) { $('#fps').textContent = `${Math.round((frames * 1000) / (now - fpsAt))} fps`; frames = 0; fpsAt = now; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

const app = new App();
window.nammaSpace = app; // handy for debugging and automated checks
app.start().catch((err) => {
  console.error(err);
  $('#loading-text').textContent = `Could not open this space: ${err.message}`;
});
