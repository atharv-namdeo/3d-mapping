/**
 * PathVisual — the route drawn on the floor: a ribbon with chevrons flowing towards
 * the destination, a ghost where furniture hides it, and a beacon at the goal.
 */
import * as THREE from 'three';
import { RENDER_ORDER } from './viewer.js';

const RIBBON_WIDTH = 0.26;
const SAMPLE_SPACING = 0.08;

const VERTEX = /* glsl */`
  attribute float along;
  varying vec2 vUv;
  varying float vAlong;
  void main() {
    vUv = uv;
    vAlong = along;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAGMENT = /* glsl */`
  uniform float uTime, uLength, uWalked, uOpacity;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying float vAlong;
  void main() {
    float edge = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x);
    // Chevrons: a V-shaped phase offset makes the stripes point along the direction of travel.
    float phase = fract((vAlong + abs(vUv.x - 0.5) * 0.36 - uTime * 0.75) / 0.55);
    float chevron = smoothstep(0.0, 0.1, phase) * smoothstep(0.52, 0.4, phase);
    float ends = smoothstep(0.0, 0.25, vAlong) * smoothstep(0.0, 0.25, uLength - vAlong);
    float walked = smoothstep(uWalked - 0.3, uWalked + 0.1, vAlong);   // fade what is behind the walker
    vec3 color = mix(uColor, vec3(1.0), chevron * 0.8);
    float alpha = edge * ends * (0.5 + 0.45 * chevron) * mix(0.12, 1.0, walked) * uOpacity;
    gl_FragColor = vec4(color, alpha);
  }`;

function resample(points, spacing) {
  const out = [];
  let walked = 0;
  for (let k = 1; k < points.length; k++) {
    const [ax, az] = points[k - 1], [bx, bz] = points[k];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / spacing));
    for (let s = k === 1 ? 0 : 1; s <= n; s++) {
      out.push({ x: ax + ((bx - ax) * s) / n, z: az + ((bz - az) * s) / n, along: walked + (len * s) / n });
    }
    walked += len;
  }
  return out;
}

function ribbonGeometry(points) {
  const samples = resample(points, SAMPLE_SPACING);
  const n = samples.length;
  const position = new Float32Array(n * 6), uv = new Float32Array(n * 4), along = new Float32Array(n * 2);
  const index = [];
  for (let k = 0; k < n; k++) {
    const prev = samples[Math.max(0, k - 1)], next = samples[Math.min(n - 1, k + 1)];
    let tx = next.x - prev.x, tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    const nx = -tz * RIBBON_WIDTH / 2, nz = tx * RIBBON_WIDTH / 2;   // left of travel
    position.set([samples[k].x + nx, 0, samples[k].z + nz, samples[k].x - nx, 0, samples[k].z - nz], k * 6);
    uv.set([0, 0, 1, 0], k * 4);
    along.set([samples[k].along, samples[k].along], k * 2);
    if (k < n - 1) index.push(k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 1, k * 2 + 2, k * 2 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('along', new THREE.BufferAttribute(along, 1));
  g.setIndex(index);
  return g;
}

export class PathVisual {
  constructor(scene, color = 0x4d9bff) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.uniforms = { uTime: { value: 0 }, uLength: { value: 1 }, uWalked: { value: 0 }, uOpacity: { value: 1 }, uColor: { value: new THREE.Color(color) } };
    const material = (extra) => new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide, ...extra,
    });
    // Visible part respects the occluders; the ghost draws only where something is in front.
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), material({ uniforms: this.uniforms }));
    this.ribbon.renderOrder = RENDER_ORDER.path;
    this.ghostUniforms = { ...this.uniforms, uOpacity: { value: 0.28 } };
    this.ghost = new THREE.Mesh(this.ribbon.geometry, material({ uniforms: this.ghostUniforms, depthFunc: THREE.GreaterDepth }));
    this.ghost.renderOrder = RENDER_ORDER.pathGhost;
    this.ribbon.position.y = this.ghost.position.y = 0.03;
    this.ribbon.frustumCulled = this.ghost.frustumCulled = false;

    // Destination beacon: a soft column of light plus a pulsing ring on the floor.
    const column = new THREE.CylinderGeometry(0.11, 0.11, 2.4, 24, 1, true).translate(0, 1.2, 0);
    this.beaconUniforms = { uTime: this.uniforms.uTime, uFade: { value: 1 }, uColor: { value: new THREE.Color(0xff5d73) } };
    this.beacon = new THREE.Mesh(column, new THREE.ShaderMaterial({
      uniforms: this.beaconUniforms, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      vertexShader: 'varying float vH; void main(){ vH = position.y / 2.4; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uTime, uFade; uniform vec3 uColor; varying float vH; void main(){ float a = pow(1.0 - vH, 2.0) * (0.55 + 0.2 * sin(uTime * 3.0 - vH * 9.0)) * uFade; gl_FragColor = vec4(uColor, a); }',
    }));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.27, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff5d73, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    this.ring.position.y = 0.035;
    this.beacon.renderOrder = this.ring.renderOrder = RENDER_ORDER.beacon;
    this.goal = new THREE.Group();
    this.goal.add(this.beacon, this.ring);
    this.group.add(this.ghost, this.ribbon, this.goal);
  }

  /** Show a route (array of [x, z]); pass null to hide. */
  setRoute(points) {
    if (!points || points.length < 2) { this.group.visible = false; return; }
    this.ribbon.geometry.dispose();
    const g = ribbonGeometry(points);
    this.ribbon.geometry = this.ghost.geometry = g;
    const [gx, gz] = points[points.length - 1];
    this.goal.position.set(gx, 0, gz);
    this.uniforms.uLength.value = g.attributes.along.array[g.attributes.along.count - 1];
    this.uniforms.uWalked.value = 0;
    this.group.visible = true;
  }

  setWalked(metres) { this.uniforms.uWalked.value = metres; }

  /** Ghost strength: subtle over a photoreal scan, clearer inside the solid blueprint model. */
  setGhostOpacity(value) { this.ghostUniforms.uOpacity.value = value; }

  /** @param {THREE.Vector3} [eye] camera position, used to fade the beacon when standing next to it */
  update(time, eye) {
    this.uniforms.uTime.value = time;
    if (eye) {
      const d = Math.hypot(eye.x - this.goal.position.x, eye.z - this.goal.position.z);
      this.beaconUniforms.uFade.value = Math.min(1, Math.max(0.12, (d - 0.5) / 2.0));
    }
    const pulse = 1 + 0.35 * (0.5 + 0.5 * Math.sin(time * 3));
    this.ring.scale.set(pulse, 1, pulse);
    this.ring.material.opacity = 1.25 - pulse * 0.6;
  }
}
