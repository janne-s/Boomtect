import { FLAT_SURFACE, terrainSurface } from '../domain/terrain.js';

let surface = FLAT_SURFACE;

export function useTerrain(terrain) {
  surface = terrainSurface(terrain);
  return surface;
}

export const currentSurface = () => surface;

export function arcs(points) {
  const values = new Float64Array(points.length);
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    values[index] = values[index - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return values;
}

export function cached(cache, emitter, extra, compute) {
  const { name: _name, enabled: _enabled, ...shape } = emitter;
  const key = JSON.stringify([shape, extra]);
  const entry = cache.get(emitter.id);
  if (entry?.key === key) return entry.value;
  const value = compute();
  cache.set(emitter.id, { key, value });
  return value;
}
