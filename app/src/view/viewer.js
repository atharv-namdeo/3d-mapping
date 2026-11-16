/**
 * Viewer — owns the WebGL renderer, camera and the scene's visual representations.
 *
 * Three layers share one navigation frame (metres, +Y up, floor at y = 0):
 *   photoreal  Gaussian splats (or a colour point cloud) of the real capture
 *   blueprint  floor-plan texture + extruded obstacle heightfield derived from nav.json
 *   nav        translucent walkable-area / clearance overlay, for inspecting the planner
 */
import * as THREE from 'three';
import * as GaussianSplats3D from '../../vendor/gaussian-splats-3d.module.js';

export const EYE_HEIGHT = 1.55;
const BLUEPRINT_CUT = 1.15;   // metres: blueprint mode slices the model here

/** Order matters: splats draw first, occluders write depth, guidance draws over both. */
export const RENDER_ORDER = { occluder: 10, navOverlay: 15, pathGhost: 20, path: 21, beacon: 22 };

/**
 * Does this browser run WebAssembly SIMD? The splat sorter ships a SIMD build that never
 * reports back on engines without it, which would leave the scan loading forever.
 */
function wasmSimdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch {
    return false;
  }
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x0b0d12, 1);
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.05, 200);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f9c, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 8, 2);
    this.scene.add(sun);

    this.photoreal = null;
    this.blueprint = new THREE.Group();
    this.navOverlay = null;
    this.scene.add(this.blueprint);
    this.mode = 'blueprint';
    this.pixelRatioCap = 1.5;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Build the geometry that needs nothing but nav.json: blueprint, occluders, nav overlay. */
  buildDerived(grid, floorplanUrl) {
    const { minX, minZ, maxX, maxZ } = grid.bounds;
    const w = maxX - minX, d = maxZ - minZ;
    const plane = () => {
      const g = new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      // PlaneGeometry's v axis runs towards −Z after the rotation; flip it so image row 0 = min Z.
      const uv = g.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - uv.getY(k));
      g.translate(minX + w / 2, 0, minZ + d / 2);
      return g;
    };

    const tex = new THREE.TextureLoader().load(floorplanUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    this.floorplan = new THREE.Mesh(plane(), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    this.floorplan.position.y = -0.005;
    this.blueprint.add(this.floorplan);

    // One instanced box per occupied cell — a few thousand instances, a single draw call.
    const cells = [];
    for (let k = 0; k < grid.obstacleHeight.length; k++) if (grid.obstacleHeight[k] > 0) cells.push(k);
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    // Full-height copy hides the route behind real furniture in photoreal mode; the blueprint
    // copy is cut off at chest height, like an architectural model you can see across.
    this.occluders = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true }), cells.length);
    this.model = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xffffff }), cells.length);
    const m = new THREE.Matrix4(), color = new THREE.Color();
    cells.forEach((k, n) => {
      const i = k % grid.width, j = Math.floor(k / grid.width), h = grid.obstacleHeight[k];
      const x = grid.x0 + (i + 0.5) * grid.res, z = grid.z0 + (j + 0.5) * grid.res;
      this.occluders.setMatrixAt(n, m.makeScale(grid.res, h, grid.res).setPosition(x, 0, z));
      this.model.setMatrixAt(n, m.makeScale(grid.res, Math.min(h, BLUEPRINT_CUT), grid.res).setPosition(x, 0, z));
      // Walls (taller than the cut) read darker than furniture.
      this.model.setColorAt(n, h > BLUEPRINT_CUT ? color.setHex(0x8792a8) : color.setHSL(0.6, 0.2, 0.74 + 0.2 * (h / BLUEPRINT_CUT)));
    });
    this.occluders.renderOrder = RENDER_ORDER.occluder;
    this.occluders.frustumCulled = this.model.frustumCulled = false;
    this.scene.add(this.occluders);
    this.blueprint.add(this.model);

    // Walkable-area overlay: green where there is elbow room, amber where it gets tight.
    const data = new Uint8Array(grid.width * grid.height * 4);
    for (let k = 0; k < grid.walkable.length; k++) {
      if (!grid.walkable[k]) continue;
      const tight = 1 - Math.min(1, grid.clearance[k] / 0.5);
      data.set([40 + 215 * tight, 220 - 60 * tight, 130 - 90 * tight, 120], k * 4);
    }
    const navTex = new THREE.DataTexture(data, grid.width, grid.height);
    navTex.magFilter = THREE.NearestFilter;
    navTex.needsUpdate = true;
    this.navOverlay = new THREE.Mesh(plane(), new THREE.MeshBasicMaterial({ map: navTex, transparent: true, depthWrite: false }));
    this.navOverlay.position.y = 0.012;
    this.navOverlay.renderOrder = RENDER_ORDER.navOverlay;
    this.navOverlay.visible = false;
    this.scene.add(this.navOverlay);
    this.setMode(this.mode);
  }

  /**
   * Load the capture itself. Resolves once the first frame can be drawn.
   * @param {(fraction: number) => void} onProgress
   */
  async loadPhotoreal(baseUrl, assets, { lite = false, pointSize = 0.04, onProgress = () => {} } = {}) {
    if (assets.splat) {
      const url = baseUrl + (lite && assets.splatLite ? assets.splatLite : assets.splat);
      const splats = new GaussianSplats3D.DropInViewer({
        sharedMemoryForWorkers: false,  // works on any static host (no COOP/COEP headers needed)
        gpuAcceleratedSort: false,
        sphericalHarmonicsDegree: 0,
        freeIntermediateSplatData: true,
        enableSIMDInSort: wasmSimdSupported(),
      });
      await splats.addSplatScene(url, {
        showLoadingUI: false, splatAlphaRemovalThreshold: 6,
        onProgress: (percent) => onProgress(Math.min(1, percent / 100)),
      });
      this.photoreal = splats;
    } else if (assets.points) {
      const buffer = await (await fetch(baseUrl + assets.points)).arrayBuffer();
      const STRIDE = 15, n = Math.floor(buffer.byteLength / STRIDE);
      const view = new DataView(buffer);
      const pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
      for (let k = 0; k < n; k++) {
        for (let a = 0; a < 3; a++) {
          pos[k * 3 + a] = view.getFloat32(k * STRIDE + a * 4, true);
          col[k * 3 + a] = view.getUint8(k * STRIDE + 12 + a);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
      this.photoreal = new THREE.Points(g, new THREE.PointsMaterial({ size: pointSize, vertexColors: true, sizeAttenuation: true }));
      this.photoreal.frustumCulled = false;
      onProgress(1);
    }
    if (this.photoreal) this.scene.add(this.photoreal);
    this.setMode('photoreal');
  }

  /** 'photoreal' shows the capture; 'blueprint' shows only geometry derived from nav.json. */
  setMode(mode) {
    this.mode = mode === 'photoreal' && !this.photoreal ? 'blueprint' : mode;
    const real = this.mode === 'photoreal';
    if (this.photoreal) this.photoreal.visible = real;
    this.blueprint.visible = !real;
    if (this.occluders) this.occluders.visible = real;
    this.renderer.setClearColor(real ? 0x0b0d12 : 0xdfe4ee, 1);
  }

  toggleNavOverlay(force) {
    if (!this.navOverlay) return false;
    this.navOverlay.visible = force ?? !this.navOverlay.visible;
    return this.navOverlay.visible;
  }

  /** World-space ray through a canvas pixel (CSS coordinates relative to the canvas). */
  rayThrough(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector3(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, 0.5);
    ndc.unproject(this.camera);
    const origin = this.camera.position;
    const dir = ndc.sub(origin).normalize();
    return { origin: [origin.x, origin.y, origin.z], direction: [dir.x, dir.y, dir.z] };
  }

  /** Project a world point to CSS pixels; `visible` is false behind the camera. */
  project(x, y, z, out = {}) {
    const v = this._v ?? (this._v = new THREE.Vector3());
    v.set(x, y, z).project(this.camera);
    out.x = (v.x * 0.5 + 0.5) * this.container.clientWidth;
    out.y = (-v.y * 0.5 + 0.5) * this.container.clientHeight;
    out.visible = v.z > -1 && v.z < 1;
    return out;
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
