import { barrageRounds } from '../domain/barrage.js';
import { emitterFlashes, fireworksRounds } from '../domain/emitters.js';
import { boosterPath, flightMembers, flightPath, whipPath } from '../domain/flight.js';
import { meteorTrack, showerMembers } from '../domain/meteor.js';
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

const paths = new Map();

/**
 * The tracks of a flight's, formation's, whip's, booster's, meteor's, or shower's bodies in the given air: times
 * and positions every `step` seconds, cached by everything except the name and switch. A whip's
 * stands, and a booster lands, on the current terrain.
 */
export function cachedTracks(emitter, air) {
  const { name, enabled, ...shape } = emitter;
  const key = JSON.stringify([shape, air]);
  const cached = paths.get(emitter.id);
  if (cached?.key === key && cached.surface === surface) return cached.paths;
  const value = emitter.kind === 'whip' ? [whipPath(emitter, air, surface)] : emitter.kind === 'booster' ? [boosterPath(emitter, air, surface)]
    : isFlightKind(emitter) ? flightMembers(emitter).map(member => flightPath(member, air)) : showerMembers(emitter).map(meteorTrack);
  paths.set(emitter.id, { key, surface, paths: value });
  return value;
}

/** A barrage or a fireworks display: blasts over an area around a centre on the ground. */
export const isFieldKind = emitter => emitter.kind === 'barrage' || emitter.kind === 'fireworks';
export const isFlightKind = emitter => emitter.kind === 'flight' || emitter.kind === 'formation';
export const isTrackKind = emitter => isFlightKind(emitter) || emitter.kind === 'whip' || emitter.kind === 'booster' || emitter.kind === 'meteor' || emitter.kind === 'shower';

const rounds = new Map();

/**
 * A barrage's rounds, or a fireworks display's thumps and bursts in the given air, as blasts,
 * cached by everything except the name and switch.
 */
export function cachedRounds(emitter, air) {
  const { name, enabled, ...shape } = emitter;
  const key = JSON.stringify(emitter.kind === 'fireworks' ? [shape, air] : shape);
  const cached = rounds.get(emitter.id);
  if (cached?.key === key) return cached.rounds;
  const value = emitter.kind === 'fireworks' ? fireworksRounds(emitter, air) : barrageRounds(emitter);
  rounds.set(emitter.id, { key, rounds: value });
  return value;
}
