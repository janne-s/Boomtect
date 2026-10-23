import { barrageRounds } from '../domain/barrage.js';
import { emitterFlashes, fireworksRounds } from '../domain/emitters.js';
import { boosterPath, flightMembers, whipPath } from '../domain/flight.js';
import { flightPath } from '../shared/domain/trajectory.js';
import { meteorBursts, meteorTrack, showerMembers } from '../domain/meteor.js';
import { arcs, cached, currentSurface } from '../shared/ui/geometry-cache.js';
import { followedPath } from '../shared/domain/follower.js';

export { currentSurface, useTerrain } from '../shared/ui/geometry-cache.js';

const caches = new WeakMap();

export function cachedFlashes(emitter) {
  const surface = currentSurface();
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

export function cachedTracks(emitter, air) {
  const surface = currentSurface();
  if (trackSurfaces.get(emitter.id) !== surface) tracks.delete(emitter.id);
  trackSurfaces.set(emitter.id, surface);
  return cached(tracks, emitter, air, () => (emitter.kind === 'whip' ? [whipPath(emitter, air, surface)] : emitter.kind === 'booster' ? [boosterPath(emitter, air, surface)]
    : emitter.paths ? emitter.paths.map(followedPath)
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
