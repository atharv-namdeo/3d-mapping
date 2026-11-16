/**
 * Navigator — the navigation session: where the visitor wants to go, the current
 * route, live progress, automatic re-routing and multi-stop trips.
 *
 * It knows nothing about rendering; the UI listens to its events:
 *   'route'     a (new) route is active, or null when navigation ends
 *   'progress'  emitted from update() with distances and the next instruction
 *   'arrive'    the visitor reached a stop; detail.final is true for the last one
 *   'unreachable'  no walkable route exists to the requested destination
 */
import { findPath, distanceField, WALKER } from './pathfinder.js';
import { buildSteps, progress, orderStops } from './guidance.js';

const ARRIVE_RADIUS = 0.55;      // metres from the goal that count as "there"
const OFF_ROUTE = 0.9;           // lateral drift that triggers a re-plan
const REPLAN_INTERVAL = 0.5;     // seconds between automatic re-plans

export class Navigator extends EventTarget {
  constructor(grid, store) {
    super();
    this.grid = grid;
    this.store = store;
    this.walker = WALKER.standard;
    this.stops = [];             // queue of { name, target: [x, z], poi? }
    this.route = null;
    this.steps = [];
    this.state = null;
    this.sinceReplan = 0;
    this.field = null;           // walking-distance field from the visitor, for search ranking
    this.fieldFrom = null;
  }

  get active() { return this.route !== null; }
  get destination() { return this.stops[0] ?? null; }

  setWalker(profile) {
    this.walker = WALKER[profile] ?? WALKER.standard;
    this.field = null;
    if (this.active && this.lastPosition) this.#plan(this.lastPosition);
  }

  /** Walking distance (m) from the visitor to a POI — Infinity if it cannot be reached. */
  walkingDistance(position, poi) {
    if (!this.field || Math.hypot(position[0] - this.fieldFrom[0], position[1] - this.fieldFrom[1]) > 0.5) {
      this.field = distanceField(this.grid, position, this.walker);
      this.fieldFrom = [...position];
    }
    const spot = this.grid.nearestFree(poi.position[0], poi.position[2], this.walker.radius, 4);
    if (!spot) return Infinity;
    const [i, j] = this.grid.cellOf(spot[0], spot[1]);
    return this.field[j * this.grid.width + i];
  }

  /** Route without committing to it — used to preview a search result. */
  preview(position, target) { return findPath(this.grid, position, target, this.walker); }

  /** Start navigating to one destination (a POI or any floor point). */
  navigateTo(position, stop) { return this.navigateTrip(position, [stop], { optimise: false }); }

  /** Navigate through several stops; by default they are re-ordered to shorten the walk. */
  navigateTrip(position, stops, { optimise = true } = {}) {
    let queue = stops.map((s) => (s.target ? s : { name: s.name, poi: s, target: [s.position[0], s.position[2]] }));
    if (optimise && queue.length > 2) {
      const at = (k) => (k < 0 ? position : queue[k].target);
      const memo = new Map();
      const cost = (a, b) => {
        const key = `${a}:${b}`;
        if (!memo.has(key)) memo.set(key, findPath(this.grid, at(a), at(b), this.walker)?.length ?? 1e6);
        return memo.get(key);
      };
      queue = orderStops(queue.length, cost).map((k) => queue[k]);
    }
    this.stops = queue;
    return this.#plan(position);
  }

  stop() {
    this.stops = [];
    this.route = null;
    this.steps = [];
    this.state = null;
    this.dispatchEvent(new CustomEvent('route', { detail: null }));
  }

  #plan(position) {
    const stop = this.destination;
    if (!stop) return null;
    const route = findPath(this.grid, position, stop.target, this.walker);
    if (!route) {
      this.dispatchEvent(new CustomEvent('unreachable', { detail: stop }));
      this.stop();
      return null;
    }
    this.route = route;
    this.steps = buildSteps(route.points, {
      destination: stop.name,
      landmarkAt: (x, z) => {
        const near = this.store.spatial.withinRadius(x, z, 1.1).find(({ poi }) => poi !== stop.poi && !poi.zone);
        return near ? near.poi.name : null;
      },
    });
    this.sinceReplan = 0;
    this.dispatchEvent(new CustomEvent('route', { detail: { route, steps: this.steps, stop, remainingStops: this.stops.length - 1 } }));
    return route;
  }

  /** Call every frame with the visitor's floor position. */
  update(position, dt) {
    this.lastPosition = position;
    if (!this.route) return;
    this.sinceReplan += dt;
    const state = progress(this.route, this.steps, position[0], position[1]);
    const toGoal = Math.hypot(position[0] - this.route.goal[0], position[1] - this.route.goal[1]);

    if (toGoal < ARRIVE_RADIUS || state.remaining < 0.15) {
      const reached = this.stops.shift();
      const final = this.stops.length === 0;
      this.dispatchEvent(new CustomEvent('arrive', { detail: { stop: reached, final } }));
      if (final) this.stop(); else this.#plan(position);
      return;
    }
    if (state.offRoute > OFF_ROUTE && this.sinceReplan > REPLAN_INTERVAL) {
      this.#plan(position);
      this.dispatchEvent(new CustomEvent('reroute'));
      return;
    }
    this.state = { ...state, eta: state.remaining / this.walker.speed, stop: this.destination, remainingStops: this.stops.length - 1 };
    this.dispatchEvent(new CustomEvent('progress', { detail: this.state }));
  }
}
