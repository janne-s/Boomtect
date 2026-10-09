import { emitterFlashes } from '../domain/emitters.js';

const cache = new Map();

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
 * Channels and strokes of an emitter for drawing, cached by everything except its name and
 * switch. Every channel carries the arc length of its points.
 */
export function cachedFlashes(emitter) {
  const { name, enabled, ...shape } = emitter;
  const key = JSON.stringify(shape);
  const cached = cache.get(emitter.id);
  if (cached?.key === key) return cached.flashes;
  let flashes;
  try { flashes = emitterFlashes(emitter); } catch { flashes = []; }
  for (const flash of flashes) for (const channel of flash.channels) channel.arcs = arcs(channel.points);
  cache.set(emitter.id, { key, flashes });
  return flashes;
}
