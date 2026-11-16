/**
 * Director — scripted camera moves that temporarily take over from the player:
 *   flyTo      the search "jump": a fast, eased hop that lifts over furniture
 *   follow     autopilot along a route at walking pace, looking where it is going
 * Any movement key hands control straight back to the user.
 */
import { EYE_HEIGHT } from './viewer.js';
import { pointAlong } from '../core/guidance.js';
import { polylineLength } from '../core/pathfinder.js';
import { Player } from './player.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function lerpAngle(a, b, t) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export class Director {
  constructor(player) {
    this.player = player;
    this.active = null;
  }

  get busy() { return this.active !== null; }
  get autopilot() { return this.active?.kind === 'follow'; }

  cancel() {
    if (!this.active) return;
    const { resolve } = this.active;
    this.active = null;
    this.player.enabled = true;
    this.player.y = EYE_HEIGHT;
    resolve?.(false);
  }

  /** Fly to stand at (x, z) facing `yaw`. Resolves true when it lands, false if interrupted. */
  flyTo(x, z, yaw, { pitch = -0.08, duration } = {}) {
    this.cancel();
    const p = this.player;
    const dist = Math.hypot(x - p.x, z - p.z);
    const seconds = duration ?? Math.min(1.6, 0.55 + dist * 0.11);
    p.enabled = false;
    return new Promise((resolve) => {
      this.active = { kind: 'fly', t: 0, seconds, from: { x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch }, to: { x, z, yaw, pitch }, lift: Math.min(0.7, dist * 0.12), resolve };
    });
  }

  /** Walk the route automatically, starting from wherever the player is along it. */
  follow(route, { speed = 1.5, startAlong = 0 } = {}) {
    this.cancel();
    this.player.enabled = false;
    return new Promise((resolve) => {
      this.active = { kind: 'follow', points: route.points, length: polylineLength(route.points), along: startAlong, speed, resolve };
    });
  }

  update(dt) {
    const a = this.active;
    if (!a) return;
    const p = this.player;
    if (p.hasInput) { this.cancel(); return; }

    if (a.kind === 'fly') {
      a.t = Math.min(1, a.t + dt / a.seconds);
      const k = ease(a.t);
      p.x = a.from.x + (a.to.x - a.from.x) * k;
      p.z = a.from.z + (a.to.z - a.from.z) * k;
      p.y = EYE_HEIGHT + Math.sin(Math.PI * k) * a.lift;
      p.yaw = lerpAngle(a.from.yaw, a.to.yaw, k);
      p.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * k - Math.sin(Math.PI * k) * 0.12;
      if (a.t >= 1) this.#finish();
    } else {
      a.along = Math.min(a.length, a.along + a.speed * dt);
      const here = pointAlong(a.points, a.along);
      const ahead = pointAlong(a.points, Math.min(a.length, a.along + 1.1));
      p.x = here.point[0]; p.z = here.point[1];
      const facing = a.length - a.along > 0.3 ? Player.yawTowards(p.x, p.z, ahead.point[0], ahead.point[1]) : p.yaw;
      p.yaw = lerpAngle(p.yaw, facing, 1 - Math.exp(-dt * 5));
      p.pitch += (-0.16 - p.pitch) * (1 - Math.exp(-dt * 3));
      p.distanceWalked += a.speed * dt;
      if (a.along >= a.length) this.#finish();
    }
  }

  #finish() {
    const { resolve } = this.active;
    this.active = null;
    this.player.enabled = true;
    this.player.y = EYE_HEIGHT;
    resolve?.(true);
  }
}
