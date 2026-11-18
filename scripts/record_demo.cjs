#!/usr/bin/env node
/**
 * Records the Round 2 demonstration video by driving the real web app frame by frame.
 *
 *   python3 -m http.server 8765 &                 # serve the repository root
 *   node scripts/record_demo.cjs [outDir] [home|office|editor|cards ...]   (default: everything)
 *   → outDir/namma_space_round2_demo.mp4
 *
 * The app is opened with ?capture=1, which hands its clock to this script: every video
 * frame is one app.step(1/FPS) followed by a screenshot, so the result is smooth even on a
 * machine without a GPU. Nothing is mocked — searches are typed, buttons are clicked.
 * Requires Playwright (with Chromium) and ffmpeg.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FPS = 12;
const SIZE = { width: 1280, height: 720 };
const BASE = process.env.DEMO_URL || 'http://127.0.0.1:8765/app/';
const OUT = path.resolve(process.argv[2] || 'demo-out');
const ONLY = process.argv.slice(3);

class Take {
  constructor(page, dir, settleMs) { this.page = page; this.dir = dir; this.settle = settleMs; this.n = 0; }

  async frame() {
    // The splat depth-sort runs in a worker; give it a moment before drawing the frame.
    if (this.settle) await this.page.waitForTimeout(this.settle);
    await this.page.evaluate((dt) => window.nammaSpace.step(dt), 1 / FPS);
    const file = path.join(this.dir, `${String(this.n++).padStart(5, '0')}.jpg`);
    await this.page.screenshot({ path: file, type: 'jpeg', quality: 92, timeout: 180000 });
  }

  async hold(seconds) { for (let k = 0; k < Math.round(seconds * FPS); k++) await this.frame(); }
  js(fn, arg) { return this.page.evaluate(fn, arg); }

  async caption(text) {
    await this.js((t) => {
      let el = document.getElementById('demo-caption');
      if (!el) {
        el = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'demo-caption' }));
        el.style.cssText = 'position:fixed;right:16px;bottom:44px;max-width:400px;padding:12px 16px;border-radius:12px;background:rgba(8,10,16,.9);border:1px solid rgba(255,255,255,.18);border-left:4px solid #4d9bff;color:#fff;font:600 16px/1.35 system-ui,sans-serif;z-index:60;box-shadow:0 10px 40px rgba(0,0,0,.5)';
      }
      el.textContent = t;
      el.style.display = t ? 'block' : 'none';
    }, text);
  }

  /** Smoothly turn the head by (yaw, pitch) radians over `seconds`. */
  async look(yaw, pitch, seconds) {
    const n = Math.round(seconds * FPS);
    for (let k = 0; k < n; k++) {
      await this.js(([dy, dp]) => { const p = window.nammaSpace.player; p.yaw += dy; p.pitch += dp; }, [yaw / n, pitch / n]);
      await this.frame();
    }
  }

  async keys(keys, seconds) {
    for (const k of keys) await this.page.keyboard.down(k);
    await this.hold(seconds);
    for (const k of keys) await this.page.keyboard.up(k);
  }

  async type(text) { for (const ch of text) { await this.page.keyboard.type(ch); await this.frame(); await this.frame(); } }

  /** Show a pointer at an element, then click it. */
  async click(selector, options = {}) {
    if (!(await this.page.locator(selector).first().isVisible())) {
      console.warn(`  (skipped click: ${selector} is not on screen)`);
      return;
    }
    const box = await this.page.locator(selector).first().boundingBox();
    if (box) await this.pointer(box.x + box.width / 2, box.y + box.height / 2);
    await this.page.locator(selector).first().click({ force: true, ...options });
    await this.hold(0.4);
  }

  async clickAt(x, y) { await this.pointer(x, y); await this.page.mouse.click(x, y); await this.hold(0.4); }

  async pointer(x, y) {
    await this.js(([px, py]) => {
      let el = document.getElementById('demo-pointer');
      if (!el) {
        el = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'demo-pointer' }));
        el.style.cssText = 'position:fixed;width:22px;height:22px;margin:-11px;border-radius:50%;border:3px solid #fff;background:rgba(77,155,255,.55);box-shadow:0 0 0 2px rgba(0,0,0,.5);z-index:70;pointer-events:none';
      }
      el.style.left = `${px}px`; el.style.top = `${py}px`; el.style.display = 'block';
    }, [x, y]);
    await this.hold(0.35);
  }

  /** Screen position of a floor point, for clicking "in the world". */
  screenOf(x, y, z) { return this.js(([a, b, c]) => { const s = window.nammaSpace.viewer.project(a, b, c); return [s.x, s.y]; }, [x, y, z]); }
  async until(predicate, maxSeconds) { for (let k = 0; k < maxSeconds * FPS && !(await this.js(predicate)); k++) await this.frame(); }
}

const SEGMENTS = {
  // ── Our own capture: the hostel, recorded with PoseCam ─────────────────────────
  hostel: { query: 'scene=hostel', settle: 0, async run(t) {
    await t.js(() => { const a = window.nammaSpace; a.player.place(-13.1, 23.1, Math.PI); a.player.pitch = -0.05; });
    await t.caption('Our hostel, captured with our PoseCam app: one 4-minute walk, 174 m, ARCore poses in real metres.');
    await t.hold(2.5);
    await t.look(Math.PI, 0, 4);
    await t.caption('Free first-person roaming (W A S D + mouse). Walls and objects stop you.');
    await t.keys(['w'], 2.2);
    await t.look(0.5, 0, 1.2);
    await t.caption('Click a label or anywhere inside a zone to see what it is and how far it is on foot.');
    await t.click('.poi-pin:has-text("Visitor seating")');
    await t.hold(3);
    await t.click('.card__close');
    await t.js(() => { const a = window.nammaSpace; a.deselect(); a.player.place(-13.1, 21.6, 0); a.player.pitch = -0.08; });
    await t.caption('Search understands everyday words: “nearest fire extinguisher” is ranked by walking distance.');
    await t.page.keyboard.press('/');
    await t.type('nearest fire extinguisher');
    await t.hold(3);
    await t.caption('Enter → a walking route that stays on the floor and keeps clear of walls and objects.');
    await t.page.keyboard.press('Enter');
    await t.hold(1);
    await t.click('#map-expand');
    await t.hold(4);
    await t.click('#map-expand');
    await t.caption('Auto-walk follows the route; the guidance names landmarks and updates as you move.');
    await t.page.keyboard.press('g');
    await t.until(() => !window.nammaSpace.navigator.active, 18);
    await t.hold(2);
    await t.caption('Aliases work too: “stairs” finds the Staircase 70 m away. Shift+Enter jumps straight there.');
    await t.page.keyboard.press('/');
    await t.type('stairs');
    await t.hold(2);
    await t.page.keyboard.press('Shift+Enter');
    await t.until(() => !window.nammaSpace.director.busy, 4);
    await t.hold(2.5);
    await t.caption('What the planner uses: green = walkable floor found in the scan, amber = tight spots.');
    await t.js(() => { const a = window.nammaSpace; a.deselect(); a.toggleNavOverlay(); a.setMode('blueprint'); });
    await t.click('#map-expand');
    await t.hold(4);
    await t.click('#map-expand');
    await t.js(() => { const a = window.nammaSpace; a.toggleNavOverlay(); a.setMode('photoreal'); });
  } },

  // ── Real capture: walkthrough, POIs, search, route ─────────────────────────────
  home: { query: 'scene=home&quality=lite', settle: 110, waitPhotoreal: true, async run(t) {
    await t.js(() => window.nammaSpace.player.place(0.2, -0.6, Math.PI));
    await t.caption('A real home, captured on a phone and reconstructed as a Gaussian splat. Runs in the browser — nothing to install.');
    await t.hold(1.5);
    await t.look(-Math.PI * 2, 0, 9);
    await t.caption('Free first-person roaming with W A S D + mouse. Walls and furniture stop you.');
    await t.look(Math.PI / 2, 0, 1.5);
    await t.keys(['w'], 3.2);
    await t.look(Math.PI, 0, 2.5);
    await t.keys(['w'], 3.0);
    await t.js(() => { window.nammaSpace.director.flyTo(0.2, -0.6, Math.PI / 2, { duration: 1.6 }); });
    await t.until(() => !window.nammaSpace.director.busy, 3);
    await t.caption('POI tagging: click a label, a zone or any floor spot to see what it is and how far it is on foot.');
    await t.click('.poi-pin:has-text("Digital piano")');
    await t.hold(3);
    const [fx, fy] = await t.screenOf(-0.6, 0, -0.3);
    await t.clickAt(fx, fy);
    await t.hold(2.5);
    await t.click('.card__close');

    await t.js(() => { window.nammaSpace.deselect(); window.nammaSpace.player.place(4.3, -0.6, Math.PI / 2); });
    await t.caption('Spatial search: typos, aliases and “nearest …” all work. Results are ranked by walking distance.');
    await t.hold(1);
    await t.page.keyboard.press('/');
    await t.type('dinning tabel');
    await t.hold(2.5);
    await t.caption('Enter → an obstacle-aware walking route, with turn-by-turn guidance that names landmarks.');
    await t.page.keyboard.press('Enter');
    await t.hold(3);
    await t.caption('Auto-walk (G) follows the route. The path stays on observed floor and keeps body clearance.');
    await t.page.keyboard.press('g');
    await t.until(() => !window.nammaSpace.navigator.active, 9);
    await t.hold(2.5);

    await t.caption('Shift+Enter jumps straight to a search result.');
    await t.page.keyboard.press('/');
    await t.type('piano');
    await t.hold(1);
    await t.page.keyboard.press('Shift+Enter');
    await t.until(() => !window.nammaSpace.director.busy, 4);
    await t.hold(2.5);

    await t.caption('What the planner sees: green = walkable floor found in the scan, amber = tight clearance.');
    await t.js(() => { window.nammaSpace.deselect(); window.nammaSpace.player.place(0.2, -0.5, -Math.PI / 2); window.nammaSpace.toggleNavOverlay(); });
    await t.look(0, -0.55, 1.5);
    await t.look(Math.PI * 1.2, 0, 5);
    await t.click('#map-expand');
    await t.hold(3.5);
    await t.click('#map-expand');
    await t.js(() => window.nammaSpace.toggleNavOverlay());
  } },

  // ── Venue-scale benchmark: long routes, re-routing, trips ─────────────────────
  office: { query: 'scene=office', settle: 0, async run(t) {
    await t.caption('Venue-scale test: a 24 m × 16 m office with known ground truth (synthetic, labelled as such), built by the same pipeline.');
    await t.hold(2);
    await t.look(-0.6, 0, 1.5); await t.look(1.2, 0, 2.5); await t.look(-0.6, 0, 1.5);
    await t.caption('“3-seater sofas” — the brief’s own example — resolves through aliases.');
    await t.page.keyboard.press('/');
    await t.type('3-seater sofas');
    await t.hold(2);
    await t.page.keyboard.press('Enter');
    await t.click('#map-expand');
    await t.caption('A 21 m route through doorways, planned in about 35 ms with A* + clearance + path smoothing.');
    await t.hold(4.5);
    await t.click('#map-expand');
    await t.page.keyboard.press('g');
    await t.caption('Turn-by-turn guidance updates as you move: distance, time and the next manoeuvre.');
    await t.until(() => !window.nammaSpace.navigator.active, 16);
    await t.hold(2);

    await t.caption('Leave the route and it re-plans automatically from where you are.');
    await t.js(() => { const a = window.nammaSpace; a.deselect(); a.go(a.store.get('reception-desk')); });
    await t.hold(1.5);
    await t.page.keyboard.press('g');
    await t.hold(2.5);
    await t.look(-1.4, 0, 1);
    await t.keys(['w'], 2.4);
    await t.hold(2);
    await t.page.keyboard.press('g');
    await t.hold(4);
    await t.page.keyboard.press('Escape');
    await t.page.keyboard.press('Escape');

    await t.caption('Multi-stop trips: pick several places and they are visited in the shortest walking order.');
    for (const id of ['coffee-machine', 'printer', 'bookshelf']) {
      await t.js((poi) => { const a = window.nammaSpace; a.toggleTrip(a.store.get(poi)); }, id);
      await t.hold(1.4);
    }
    await t.click('.btn--trip');
    await t.click('#map-expand');
    await t.hold(3.5);
    await t.click('#map-expand');
    await t.page.keyboard.press('g');
    await t.until(() => window.nammaSpace.navigator.stops.length < 3, 14);
    await t.hold(3);
    await t.js(() => window.nammaSpace.navigator.stop());

    await t.caption('Step-free width: routes keep a 0.76 m clear path; doors that are too narrow are refused.');
    await t.js(() => { const a = window.nammaSpace; a.deselect(); a.go(a.store.get('server-racks')); });
    await t.hold(2);
    await t.click('#opt-accessible');
    await t.hold(3.5);
    await t.click('#opt-accessible');
    await t.js(() => window.nammaSpace.navigator.stop());
  } },

  // ── Tagging a venue in the browser ───────────────────────────────────────────
  editor: { query: 'scene=office', settle: 0, async run(t) {
    await t.js(() => { const a = window.nammaSpace; a.player.place(8.0, -7.6, Math.PI); a.player.pitch = -0.42; });
    await t.caption('Tagging a venue needs no tools: open the editor, click the scene, name the place.');
    await t.hold(1.5);
    await t.click('#btn-edit');
    await t.hold(2);
    const [x, y] = await t.screenOf(8.0, 0, -3.0);
    await t.clickAt(x, y);
    await t.page.locator('#editor input[name=name]').click();
    await t.type('Help point');
    await t.page.locator('#editor select[name=category]').selectOption('service');
    await t.page.locator('#editor input[name=aliases]').click();
    await t.type('info, assistance');
    await t.hold(1);
    await t.caption('Zones are drawn corner by corner on the floor; clicking inside one reveals its name.');
    await t.click('#editor button:has-text("Draw zone")');
    for (const [cx, cz] of [[7.4, -2.3], [8.55, -2.3], [8.55, -3.7], [7.4, -3.7]]) { const [px, py] = await t.screenOf(cx, 0, cz); await t.clickAt(px, py); }
    await t.click('#editor button:has-text("Finish zone")');
    await t.hold(1.5);
    await t.click('#editor button[type=submit]');
    await t.hold(2);
    await t.caption('Edits are kept as a draft in the browser and exported as pois.json to commit.');
    await t.click('#editor button:has-text("Export")');
    await t.hold(2.5);
    await t.click('#editor .icon-btn');
    await t.page.keyboard.press('/');
    await t.type('help');
    await t.hold(3);
  } },
};

const imageData = (file) => (fs.existsSync(file) ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : '');

function card(title, lines, images = []) {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d12;color:#eef1f6;font-family:system-ui,sans-serif">
  <div style="width:980px"><div style="display:flex;align-items:center;gap:18px;margin-bottom:26px">
  <span style="display:grid;place-items:center;width:64px;height:64px;border-radius:18px;background:linear-gradient(135deg,#4d9bff,#7a5cff);font:800 30px system-ui">N</span>
  <h1 style="margin:0;font-size:46px">${title}</h1></div>
  ${lines.map((l) => `<p style="margin:12px 0;font-size:${images.length ? 21 : 25}px;line-height:1.4;color:#c9cfda">${l}</p>`).join('')}
  ${images.length ? `<div style="display:flex;gap:20px;margin-top:22px">${images.map(([src, label]) => `<figure style="margin:0;flex:1"><img src="${src}" style="width:100%;height:300px;object-fit:contain;background:#05070b;border-radius:12px;border:1px solid #2a2f3a"><figcaption style="margin-top:8px;color:#9aa3b2;font-size:17px">${label}</figcaption></figure>`).join('')}</div>` : ''}</div>`;
}

const CARDS = {
  posecam: ['From one phone walk to a map', ['PoseCam saves ARCore’s pose for every frame — metres, gravity up. A depth network estimates depth per frame on a CPU; its scale is <b style="color:#fff">measured</b> by triangulating image features against ARCore’s motion (154 frame pairs).', 'Check: the phone then sits 1.33 m above the floor. Frames fuse into 4 cm voxels seen from ≥ 2 views; the walked path counts as floor.'],
    () => [[imageData(path.join(OUT, 'hostel_path.png')), 'The 174 m walk recorded by PoseCam (grey: no images uploaded)'], [imageData(path.join(OUT, 'hostel_walk.png')), 'Walkable floor (green) and obstacles (red) found by navkit']]],
  office: ['Venue-scale benchmark', ['A 24 m × 16 m office, <b style="color:#fff">synthetic</b>, generated from a known layout so accuracy can be measured exactly.', 'Same pipeline, same app — long multi-room routes, re-routing and multi-stop trips.']],
  title: ['Namma Space — Round 2', ['POI tagging · spatial search · obstacle-aware navigation', 'PoseCam phone capture → <b style="color:#fff">navkit</b> (metric depth, floor, obstacles) → zero-install web app', '<span style="color:#9aa3b2;font-size:20px">Techfest 2026-27, IIT Bombay · recorded from the live app, frame by frame</span>']],
  end: ['How it is verified', ['<b style="color:#fff">45 automated tests</b> in CI — 37 for the navigation core and shipped scenes, 8 for the pipeline', 'Every route is sampled every 2 cm and must keep body clearance from obstacles', 'On ground truth: <b style="color:#fff">0.01 %</b> of cells marked walkable are actually solid', 'A capture tilted 17° and scaled 0.21× is re-aligned to under 0.5° of gravity', 'Live app: <span style="color:#4d9bff">atharv-namdeo.github.io/3d-mapping/app</span>', 'Code: <span style="color:#4d9bff">github.com/atharv-namdeo/3d-mapping</span>']],
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const wanted = (name) => !ONLY.length || ONLY.includes(name);

  for (const [name, [title, lines, images]] of Object.entries(CARDS)) {
    if (!wanted(name) && !wanted('cards')) continue;
    const page = await browser.newPage({ viewport: SIZE });
    await page.setContent(card(title, lines, images ? images() : []));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `card_${name}.png`) });
    await page.close();
  }

  for (const [name, seg] of Object.entries(SEGMENTS)) {
    if (!wanted(name)) continue;
    const dir = path.join(OUT, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: SIZE, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
    await page.goto(`${BASE}?capture=1&${seg.query}`, { timeout: 120000 });
    await page.waitForFunction(() => window.nammaSpace?.path && document.querySelector('#loading').hidden, null, { timeout: 120000 });
    const take = new Take(page, dir, seg.settle);
    if (seg.waitPhotoreal) {
      for (let k = 0; k < 300 && !(await take.js(() => window.nammaSpace.viewer.mode === 'photoreal')); k++) { await take.js(() => window.nammaSpace.step(0)); await page.waitForTimeout(300); }
      for (let k = 0; k < 30; k++) { await take.js(() => window.nammaSpace.step(0)); await page.waitForTimeout(250); }   // splat fade-in
    }
    const t0 = Date.now();
    await seg.run(take);
    console.log(`[${name}] ${take.n} frames = ${(take.n / FPS).toFixed(1)} s of video in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    await context.close();
  }
  await browser.close();

  // Assemble: cards interleaved with the recorded takes.
  const ORDER = [['card', 'title', 7], ['card', 'posecam', 16], ['take', 'hostel'], ['card', 'office', 6], ['take', 'office'], ['take', 'editor'], ['card', 'end', 12]];
  const parts = [];
  const encode = (args, out) => { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, '-vf', 'fps=24,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', out]); parts.push(out); };
  for (const [kind, name, seconds] of ORDER) {
    const still = path.join(OUT, `card_${name}.png`);
    if (kind === 'card' && fs.existsSync(still)) encode(['-loop', '1', '-t', String(seconds), '-i', still], path.join(OUT, `_card_${name}.mp4`));
    if (kind === 'take' && fs.existsSync(path.join(OUT, name, '00000.jpg'))) encode(['-framerate', String(FPS), '-i', path.join(OUT, name, '%05d.jpg')], path.join(OUT, `_${name}.mp4`));
  }
  const list = path.join(OUT, '_list.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  const final = path.join(OUT, 'namma_space_round2_demo.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
  console.log('wrote', final);
})().catch((err) => { console.error(err); process.exit(1); });
