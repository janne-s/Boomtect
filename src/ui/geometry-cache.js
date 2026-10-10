import { barrageRounds } from '../domain/barrage.js';
import { emitterFlashes } from '../domain/emitters.js';
import { FLAT_SURFACE, terrainSurface } from '../domain/terrain.js';

/** Flashes per terrain surface, each keyed by emitter id. */
const caches = new WeakMap();
let surface = FLAT_SURFACE;

/** Sets the terrain that drawn channels follow: the current scene's. */
export function useTerrain(terrain) {
  surface = terrainSurface(terrain);
  return surface;
}

export const currentSurface = () => surface;

/** Cumulative arc length at every point of a polyline, in metres. */
function arcs(points) {
  const values = new Float64Array(points.length);
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    values[index] = values[index - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return values;
}

/**
 * Channels and strokes of an emitter for drawing over the current terrain, cached by everything
 * except its name and switch. Every channel carries the arc length of its points.
 */
export function cachedFlashes(emitter) {
  if (!caches.has(surface)) caches.set(surface, new Map());
  const cache = caches.get(surface);
  const { name, enabled, ...shape } = emitter;
  const key = JSON.stringify(shape);
  const cached = cache.get(emitter.id);
  if (cached?.key === key) return cached.flashes;
  let flashes;
  try { flashes = emitterFlashes(emitter, surface); } catch { flashes = []; }
  for (const flash of flashes) for (const channel of flash.channels) channel.arcs = arcs(channel.points);
  cache.set(emitter.id, { key, flashes });
  return flashes;
}

const rounds = new Map();

/** A barrage's rounds, cached by everything except its name and switch. */
export function cachedRounds(emitter) {
  const { name, enabled, ...shape } = emitter;
  const key = JSON.stringify(shape);
  const cached = rounds.get(emitter.id);
  if (cached?.key === key) return cached.rounds;
  const value = barrageRounds(emitter);
  rounds.set(emitter.id, { key, rounds: value });
  return value;
}
