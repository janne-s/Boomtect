import { PROPAGATION } from './constants.js';
import { deygoutEdges } from './diffraction.js';
import { multipleReflections, rayBetween, rayHeightAt, reflectedRay, speedAt } from './refraction.js';

/**
 * Sound paths over a terrain surface, in the scene frame with heights above the datum.
 *
 * Shielding (class B with the limits in `diffraction.js`): the ray is sampled every half cell and
 * checked against the ground; Deygout's edges over the ground that rises above it give the path's
 * diffraction. Ground within one cell of either end is not checked, because terrain finer than the
 * heightfield is unknown and the ground right under a microphone is the reflecting plane.
 *
 * Reflection: from the tangent plane of the ground under the receiver. A level plane uses the
 * refracted reflection exactly, solved with the profile shifted to the plane's height (a linear
 * profile stays linear). A sloping plane mirrors the source across it for straight geometry and
 * times its two legs along refracted rays (class B/C).
 */

const SAMPLES_PER_CELL = 2;
/** Ground samples along a path for its mean plane, ends included. */
const MEAN_PLANE_SAMPLES = 32;
/** A plane this close to level is treated as level. */
const LEVEL_TOLERANCE = 1e-12;

let buffers = { size: 0 };

function sampleBuffers(count) {
  if (buffers.size < count) {
    const size = Math.max(count, 2 * buffers.size, 256);
    buffers = { size, distances: new Float64Array(size), terrain: new Float64Array(size), path: new Float64Array(size) };
  }
  return buffers;
}

export function shieldingEdges(profile, surface, source, receiver) {
  if (surface.flat) return [];
  const horizontal = Math.hypot(receiver.x - source.x, receiver.y - source.y);
  const step = surface.cellMetres / SAMPLES_PER_CELL;
  const skip = surface.cellMetres;
  const count = Math.floor((horizontal - 2 * skip) / step);
  if (count < 1) return [];
  // Distances along the path, from horizontal distances by the path's slant.
  const slant = Math.hypot(horizontal, receiver.z - source.z) / horizontal;
  const { distances, terrain, path } = sampleBuffers(count);
  const unitX = (receiver.x - source.x) / horizontal;
  const unitY = (receiver.y - source.y) / horizontal;
  for (let index = 0; index < count; index += 1) {
    const along = skip + (index + .5) * step;
    distances[index] = along * slant;
    terrain[index] = surface.heightAt(source.x + unitX * along, source.y + unitY * along);
    path[index] = rayHeightAt(profile, source, receiver, along);
  }
  return deygoutEdges({
    distances: distances.subarray(0, count),
    terrain: terrain.subarray(0, count),
    path: path.subarray(0, count),
    total: horizontal * slant,
    startHeight: source.z,
    endHeight: receiver.z,
    speed: profile.groundSpeed,
    span: Math.max(1, Math.round(PROPAGATION.ridge.spanCells * SAMPLES_PER_CELL))
  });
}

/**
 * The refraction shadow of a path over terrain judged from the mean ground plane between its ends
 * (class B/C): the least-squares line through the ground profile under the path, from which the
 * equivalent heights of both ends are measured at right angles and kept at or above zero, as in
 * CNOSSOS-EU (Directive (EU) 2015/996, Annex II; formula to verify against the Annex). The linear
 * profile is taken to start at the plane's height under `b`. Returns the profile and both ends in
 * that frame, where the ground is z = 0; on level ground it is the ground under `b` exactly.
 */
export function meanPlaneFrame(profile, heightAt, a, b, samples = MEAN_PLANE_SAMPLES) {
  const horizontal = Math.hypot(b.x - a.x, b.y - a.y);
  let sumD = 0; let sumZ = 0; let sumDD = 0; let sumDZ = 0;
  for (let index = 0; index < samples; index += 1) {
    const share = index / (samples - 1);
    const d = share * horizontal;
    const z = heightAt(a.x + (b.x - a.x) * share, a.y + (b.y - a.y) * share);
    sumD += d; sumZ += z; sumDD += d * d; sumDZ += d * z;
  }
  const spread = samples * sumDD - sumD * sumD;
  const slope = spread > 0 ? (samples * sumDZ - sumD * sumZ) / spread : 0;
  const intercept = (sumZ - slope * sumD) / samples;
  const base = intercept + slope * horizontal;
  const tilt = Math.sqrt(1 + slope * slope);
  const above = (point, d) => Math.max(0, (point.z - intercept - slope * d) / tilt);
  return {
    profile: shiftedProfile(profile, base),
    from: { x: a.x, y: a.y, z: above(a, 0) },
    to: { x: b.x, y: b.y, z: above(b, horizontal) }
  };
}

/** The profile seen from ground at a given height: the same air, with c₀ taken at that height. */
export const shiftedProfile = (profile, heightMetres) => (heightMetres === 0 ? profile : { groundSpeed: speedAt(profile, heightMetres), gradient: profile.gradient });

/**
 * Rays with several ground contacts, over level ground: the plane z = 0 without terrain, or the
 * tangent plane under the receiver where it is level, as if it extended level. None over sloping
 * ground (class C).
 */
export function terrainMultipleReflections(profile, surface, source, receiver) {
  if (surface.flat) return multipleReflections(profile, source, receiver);
  const height = surface.heightAt(receiver.x, receiver.y);
  if (1 - surface.normalAt(receiver.x, receiver.y).z >= LEVEL_TOLERANCE) return [];
  const shift = point => ({ x: point.x, y: point.y, z: point.z - height });
  return multipleReflections(shiftedProfile(profile, height), shift(source), shift(receiver))
    .map(ray => ({ ...ray, groundPoint: { ...ray.groundPoint, z: height } }));
}

export function terrainReflection(profile, surface, source, receiver) {
  const ground = { x: receiver.x, y: receiver.y, z: surface.heightAt(receiver.x, receiver.y) };
  const normal = surface.normalAt(receiver.x, receiver.y);
  if (1 - normal.z < LEVEL_TOLERANCE) {
    const shift = point => ({ x: point.x, y: point.y, z: point.z - ground.z });
    const local = reflectedRay(shiftedProfile(profile, ground.z), shift(source), shift(receiver));
    return local && { ...local, groundPoint: local.groundPoint && { ...local.groundPoint, z: ground.z } };
  }
  const above = point => (point.x - ground.x) * normal.x + (point.y - ground.y) * normal.y + (point.z - ground.z) * normal.z;
  const sourceHeight = above(source);
  const receiverHeight = above(receiver);
  if (!(sourceHeight > 0 && receiverHeight > 0)) return null;
  const image = { x: source.x - 2 * sourceHeight * normal.x, y: source.y - 2 * sourceHeight * normal.y, z: source.z - 2 * sourceHeight * normal.z };
  const share = sourceHeight / (sourceHeight + receiverHeight);
  const point = { x: image.x + (receiver.x - image.x) * share, y: image.y + (receiver.y - image.y) * share, z: image.z + (receiver.z - image.z) * share };
  const imageMetres = Math.hypot(receiver.x - image.x, receiver.y - image.y, receiver.z - image.z);
  const down = rayBetween(profile, source, point);
  const up = rayBetween(profile, point, receiver);
  return {
    seconds: down.seconds + up.seconds,
    metres: down.metres + up.metres,
    spreadMetres: imageMetres,
    departure: down.departure,
    arrival: up.arrival,
    groundSine: (sourceHeight + receiverHeight) / imageMetres,
    groundPoint: point
  };
}
