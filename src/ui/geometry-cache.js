import { barrageRounds } from '../domain/barrage.js';
import { emitterFlashes, fireworksRounds } from '../domain/emitters.js';
import { boosterPath, flightMembers, flightPath, whipPath } from '../domain/flight.js';
import { meteorBursts, meteorTrack, showerMembers } from '../domain/meteor.js';
import { FLAT_SURFACE, terrainSurface } from '../domain/terrain.js';

const caches = new WeakMap();
let surface = FLAT_SURFACE;

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

/** A value per emitter id, kept while the emitter's shape (all but its name and switch) and `extra` stay the same. */
function cached(cache, emitter, extra, compute) {
  const { name: _name, enabled: _enabled, ...shape } = emitter;
  const key = JSON.stringify([shape, extra]);
  const entry = cache.get(emitter.id);
  if (entry?.key === key) return entry.value;
  const value = compute();
  cache.set(emitter.id, { key, value });
  return value;
}

/** Channels and strokes of an emitter over the current terrain; every channel carries the arc length of its points. */
export function cachedFlashes(emitter) {
  if (!caches.has(surface)) caches.set(surface, new Map());
  return cached(caches.get(surface), emitter, null, () => {
    let flashes;
    try { flashes = emitterFlashes(emitter, surface); } catch { flashes = []; }
    for (const flash of flashes) for (const channel of flash.channels) channel.arcs = arcs(channel.points);
    return flashes;
  });
}

const tracks = new Map();
const trackSurfaces = new Map();

/** The bodies' tracks of a track emitter in the given air; a whip stands, and a booster lands, on the current terrain. */
export function cachedTracks(emitter, air) {
  if (trackSurfaces.get(emitter.id) !== surface) tracks.delete(emitter.id);
  trackSurfaces.set(emitter.id, surface);
  return cached(tracks, emitter, air, () => (emitter.kind === 'whip' ? [whipPath(emitter, air, surface)] : emitter.kind === 'booster' ? [boosterPath(emitter, air, surface)]
    : isFlightKind(emitter) ? flightMembers(emitter).map(member => flightPath(member, air)) : showerMembers(emitter).map(meteorTrack)));
}

const bursts = new Map();

export const cachedBursts = (emitter, air) => cached(bursts, emitter, air, () => showerMembers(emitter).map(meteor => meteorBursts(meteor, air)));

export const isFieldKind = emitter => emitter.kind === 'barrage' || emitter.kind === 'fireworks';
export const isFlightKind = emitter => emitter.kind === 'flight' || emitter.kind === 'formation';
export const isTrackKind = emitter => isFlightKind(emitter) || emitter.kind === 'whip' || emitter.kind === 'booster' || emitter.kind === 'meteor' || emitter.kind === 'shower';

const rounds = new Map();

export const cachedRounds = (emitter, air) => cached(rounds, emitter, emitter.kind === 'fireworks' ? air : null,
  () => (emitter.kind === 'fireworks' ? fireworksRounds(emitter, air) : barrageRounds(emitter)));
