/**
 * Player — first-person walker constrained to the walkable grid.
 *
 * Input:  WASD / arrows to move, Shift to run, mouse-drag or pointer-lock (F) to look,
 *         touch: left thumb moves, right thumb looks.
 * Motion: velocity is smoothed, and collisions slide along obstacles instead of stopping.
 */
import { EYE_HEIGHT } from './viewer.js';

const BODY_RADIUS = 0.2;
const WALK_SPEED = 1.5, RUN_SPEED = 3.2;
const DRAG_THRESHOLD_PX = 5;

const KEYMAP = {
  KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};

export class Player extends EventTarget {
  constructor(viewer, grid) {
    super();
    this.viewer = viewer;
    this.grid = grid;
    this.x = 0; this.z = 0; this.y = EYE_HEIGHT;
    this.yaw = 0; this.pitch = 0;       // yaw 0 looks along −Z; positive yaw turns left
    this.vx = 0; this.vz = 0;
    this.keys = new Set();
    this.touchMove = [0, 0];
    this.enabled = true;                // false while the camera director is flying the camera
    this.distanceWalked = 0;
    this.#bind();
  }

  get position() { return [this.x, this.z]; }
  get moving() { return Math.hypot(this.vx, this.vz) > 0.05; }
  /** Unit vector the player faces, on the floor plane. */
  get forward() { return [-Math.sin(this.yaw), -Math.cos(this.yaw)]; }

  place(x, z, yaw = this.yaw, pitch = 0) {
    const spot = this.grid.nearestFree(x, z, BODY_RADIUS) ?? [x, z];
    [this.x, this.z] = spot;
    this.yaw = yaw; this.pitch = pitch; this.vx = this.vz = 0; this.y = EYE_HEIGHT;
    this.apply();
  }

  /** Yaw that makes the player at (x, z) face the point (tx, tz). */
  static yawTowards(x, z, tx, tz) { return Math.atan2(-(tx - x), -(tz - z)); }

  look(dx, dy, sensitivity = 0.0026) {
    this.yaw -= dx * sensitivity;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - dy * sensitivity));
  }

  #bind() {
    const canvas = this.viewer.canvas;
    const typing = (e) => e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]');

    window.addEventListener('keydown', (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code in KEYMAP || e.code.startsWith('Shift')) { this.keys.add(e.code); e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // Mouse: drag to look. A press that does not move is reported as a click (pick).
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (document.pointerLockElement === canvas) { this.look(e.movementX, e.movementY); return; }
      if (!drag) return;
      drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (drag.moved > DRAG_THRESHOLD_PX) { this.look(-e.movementX * 1.1, -e.movementY * 1.1); canvas.classList.add('dragging'); }
    });
    const release = (e) => {
      if (e.pointerType === 'touch' || !drag) return;
      const wasClick = drag.moved <= DRAG_THRESHOLD_PX && drag.button === 0;
      drag = null;
      canvas.classList.remove('dragging');
      if (wasClick) {
        const locked = document.pointerLockElement === canvas;
        const rect = canvas.getBoundingClientRect();
        // In mouse-look mode the crosshair (screen centre) is what gets clicked.
        this.dispatchEvent(new CustomEvent('pick', { detail: {
          clientX: locked ? rect.left + rect.width / 2 : e.clientX,
          clientY: locked ? rect.top + rect.height / 2 : e.clientY,
        } }));
      }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', () => { drag = null; });
    document.addEventListener('pointerlockchange', () => {
      this.dispatchEvent(new CustomEvent('mouselook', { detail: document.pointerLockElement === canvas }));
    });

    // Touch: the left half of the screen is a virtual stick, the right half looks around.
    const touches = new Map();
    canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        touches.set(t.identifier, { sx: t.clientX, sy: t.clientY, x: t.clientX, y: t.clientY, moved: 0, stick: t.clientX < window.innerWidth * 0.45 });
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        const s = touches.get(t.identifier);
        if (!s) continue;
        const dx = t.clientX - s.x, dy = t.clientY - s.y;
        s.moved += Math.abs(dx) + Math.abs(dy);
        if (s.stick) {
          const ox = (t.clientX - s.sx) / 60, oy = (t.clientY - s.sy) / 60;
          const len = Math.max(1, Math.hypot(ox, oy));
          this.touchMove = [ox / len, -oy / len];
        } else this.look(-dx * 1.6, -dy * 1.6);
        s.x = t.clientX; s.y = t.clientY;
      }
      e.preventDefault();
    }, { passive: false });
    const touchEnd = (e) => {
      for (const t of e.changedTouches) {
        const s = touches.get(t.identifier);
        if (!s) continue;
        if (s.stick) this.touchMove = [0, 0];
        if (s.moved < 8) this.dispatchEvent(new CustomEvent('pick', { detail: { clientX: t.clientX, clientY: t.clientY } }));
        touches.delete(t.identifier);
      }
    };
    canvas.addEventListener('touchend', touchEnd);
    canvas.addEventListener('touchcancel', touchEnd);
  }

  toggleMouseLook() {
    const canvas = this.viewer.canvas;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    else canvas.requestPointerLock?.();
  }

  /** True if the user is actively steering (used to hand control back from autopilot). */
  get hasInput() {
    return [...this.keys].some((k) => k in KEYMAP) || Math.hypot(...this.touchMove) > 0.2;
  }

  update(dt) {
    if (this.enabled) {
      let ix = this.touchMove[0], iz = this.touchMove[1];
      for (const code of this.keys) if (code in KEYMAP) { ix += KEYMAP[code][0]; iz += KEYMAP[code][1]; }
      const len = Math.hypot(ix, iz);
      if (len > 1) { ix /= len; iz /= len; }
      const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;
      const [fx, fz] = this.forward;
      const targetVx = (fx * iz - fz * ix) * speed;   // right = (−fz, fx)
      const targetVz = (fz * iz + fx * ix) * speed;
      const blend = 1 - Math.exp(-dt * 12);
      this.vx += (targetVx - this.vx) * blend;
      this.vz += (targetVz - this.vz) * blend;
      this.#move(this.vx * dt, this.vz * dt);
    }
    this.apply();
  }

  /** Collide-and-slide: try the full step, then each axis on its own. */
  #move(dx, dz) {
    if (!dx && !dz) return;
    const { grid } = this;
    const before = [this.x, this.z];
    if (grid.isFree(this.x + dx, this.z + dz, BODY_RADIUS)) { this.x += dx; this.z += dz; }
    else if (grid.isFree(this.x + dx, this.z, BODY_RADIUS)) { this.x += dx; this.vz = 0; }
    else if (grid.isFree(this.x, this.z + dz, BODY_RADIUS)) { this.z += dz; this.vx = 0; }
    else { this.vx = this.vz = 0; }
    this.distanceWalked += Math.hypot(this.x - before[0], this.z - before[1]);
  }

  apply() {
    const cam = this.viewer.camera;
    // A gentle head-bob sells the feeling of walking without causing motion sickness.
    const bob = this.enabled && this.moving ? Math.sin(this.distanceWalked * 7.5) * 0.018 : 0;
    cam.position.set(this.x, this.y + bob, this.z);
    cam.rotation.set(this.pitch, this.yaw, 0);
  }
}
