import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN } from './constants.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from './air.js';
import { inShadow, pathProfile, rayBetween, speedAt, travelSeconds, wavefront } from './refraction.js';

/**
 * A body in supersonic flight and the sonic booms it leaves at a receiver.
 *
 * Each boom leaves the flight path where the arrival time T(t) = t + travel(x(t) → receiver) is
 * stationary: there the ray to the receiver leaves on the Mach cone (class A, the stationary
 * phase of the moving source; with the travel time along refracted rays, the Mach cone bends with
 * the air). A minimum of T is a boom; where none exists the body is subsonic or the air turns the
 * cone's rays away before the ground (Mach cutoff), which follows from the rays themselves.
 *
 * Its overpressure and duration follow Carlson's simplified method (NASA TP-1122, 1978, eqs. 1–2,
 * class B; checked against its sample problems, 74 Pa and 0.17 s for problem 1):
 *   Δp = K_p·K_R·√(p_v·p_g)·(M² − 1)^⅛·r^(−¾)·l^¾·K_S,  Δt = K_t·(3.42/a_v)·M/(M² − 1)^⅜·r^¼·l^¾·K_S,
 * with the ray's length r in place of his effective altitude, K_p = K_t = 1 (his charts' atmospheric
 * factors, 0.7–1.4 in his samples; class C), and the ground reflection K_R left to the ground model,
 * so that it is counted once. Where the flight accelerates or turns, rays from neighbouring points
 * converge: the boom grows as √(T″ of straight, steady flight / T″), up to FOCUS_LIMIT (class B for
 * the stationary-phase law, class C for the limit, where ray theory fails at a caustic).
 */

/**
 * Bodies from Carlson's sample problems: length l and shape factor K_S (which replaces Whitham's
 * F-function). The rocket's boom is dominated by its exhaust plume (Apollo launch vehicle at M 4.08
 * and 36 km; K_S = 0.68 reproduces both his 184 Pa and 3.90 s).
 */
export const BODIES = Object.freeze({
  reconnaissance: Object.freeze({ label: 'Reconnaissance aircraft', lengthMetres: 32.7, shapeFactor: .087 }),
  bomber: Object.freeze({ label: 'Medium bomber', lengthMetres: 30, shapeFactor: .088 }),
  rocket: Object.freeze({ label: 'Launch vehicle', lengthMetres: 104.5, shapeFactor: .68 }),
  custom: Object.freeze({ label: 'Custom', lengthMetres: null, shapeFactor: null })
});
export const BODY_TYPES = Object.freeze(Object.keys(BODIES));

/**
 * The bodies of a flight emitter: a flight is one; a formation flies in a vee behind its leader,
 * each rank a lateral and a trailing spacing farther out and back, alternating sides (class C as a
 * pattern), all at the leader's settings.
 */
export function flightMembers(emitter) {
  if (emitter.kind !== 'formation') return [emitter];
  const heading = emitter.headingDegrees * Math.PI / 180;
  const across = { x: Math.cos(heading), y: -Math.sin(heading) };
  const along = { x: Math.sin(heading), y: Math.cos(heading) };
  return Array.from({ length: emitter.memberCount }, (_, index) => {
    const rank = Math.ceil(index / 2);
    const side = index % 2 ? 1 : -1;
    const lateral = side * rank * emitter.lateralSpacingMetres;
    const back = rank * emitter.trailSpacingMetres;
    return {
      ...emitter,
      id: `${emitter.id}:${index}`,
      startMetres: {
        x: emitter.startMetres.x + across.x * lateral - along.x * back,
        y: emitter.startMetres.y + across.y * lateral - along.y * back,
        z: emitter.startMetres.z
      }
    };
  });
}

/** Time step of the flight path, seconds, and the most steps kept. */
const STEP_SECONDS = .05;
const MAXIMUM_STEPS = 12000;
/** The growth of a focused boom over the steady one, at most (class C). */
export const FOCUS_LIMIT = 5;
/** Below this speed the body has stopped. */
const STOPPED_METRES_PER_SECOND = 1;

/** The speed of sound the body flies against: the layered air's, or the ground's in homogeneous air, as the sound travels. */
const soundSpeedAt = (air, heightMetres) => Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, air.refraction ? heightMetres : 0));

/**
 * The flight path: positions, times, and velocities every STEP_SECONDS from the onset. The speed
 * starts at the Mach number in the air at the start height and changes at the acceleration; the
 * heading turns at the turn rate; the path climbs at its angle. It ends at its duration or the ground.
 */
export function flightPath(flight, air) {
  const steps = Math.min(MAXIMUM_STEPS, Math.max(2, Math.ceil(flight.durationSeconds / STEP_SECONDS)));
  const step = flight.durationSeconds / steps;
  const climb = flight.climbDegrees * Math.PI / 180;
  const path = { seconds: [], x: [], y: [], z: [], vx: [], vy: [], vz: [], speed: [], step };
  let { x, y, z } = flight.startMetres;
  let speed = flight.mach * soundSpeedAt(air, z);
  for (let index = 0; index <= steps; index += 1) {
    const t = index * step;
    const heading = (flight.headingDegrees + flight.turnDegreesPerSecond * t) * Math.PI / 180;
    const vx = speed * Math.cos(climb) * Math.sin(heading);
    const vy = speed * Math.cos(climb) * Math.cos(heading);
    const vz = speed * Math.sin(climb);
    path.seconds.push(flight.startSeconds + t); path.x.push(x); path.y.push(y); path.z.push(z);
    path.vx.push(vx); path.vy.push(vy); path.vz.push(vz); path.speed.push(speed);
    x += vx * step; y += vy * step; z += vz * step;
    speed += flight.accelerationMetresPerSecondSquared * step;
    if (z < 0 || speed < STOPPED_METRES_PER_SECOND) break;
  }
  return path;
}

/**
 * A body supersonic at its start has been flying before it: its booms near the start left from
 * there. The path the renderer searches therefore begins APPROACH_HEIGHTS·h/√(M² − 1) plus
 * APPROACH_METRES before the start, straight and at the start's speed (class C); views draw the
 * path from the start.
 */
const APPROACH_HEIGHTS = 2;
const APPROACH_METRES = 20000;

/** The flight path with its approach before the start (see APPROACH_HEIGHTS); a subsonic start has none. */
export function withApproach(path, air) {
  const speed = path.speed[0];
  const mach = speed / soundSpeedAt(air, path.z[0]);
  if (!(mach > 1)) return path;
  const metres = APPROACH_HEIGHTS * Math.max(0, path.z[0]) / Math.sqrt(mach * mach - 1) + APPROACH_METRES;
  const steps = Math.min(MAXIMUM_STEPS, Math.ceil(metres / speed / path.step));
  const approach = { seconds: [], x: [], y: [], z: [], vx: [], vy: [], vz: [], speed: [], step: path.step };
  for (let index = steps; index >= 1; index -= 1) {
    const t = index * path.step;
    approach.seconds.push(path.seconds[0] - t);
    approach.x.push(path.x[0] - path.vx[0] * t); approach.y.push(path.y[0] - path.vy[0] * t); approach.z.push(path.z[0] - path.vz[0] * t);
    approach.vx.push(path.vx[0]); approach.vy.push(path.vy[0]); approach.vz.push(path.vz[0]); approach.speed.push(speed);
  }
  for (const key of ['seconds', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'speed']) approach[key].push(...path[key]);
  return approach;
}

/** Carlson's bow-shock overpressure, Pa, and signature duration, s, at a distance (see the module note). */
export function carlsonBoom({ mach, vehiclePressurePa, groundPressurePa, vehicleSoundSpeed, lengthMetres, shapeFactor, distanceMetres, pressureFactor = 1, durationFactor = 1, reflectionFactor = 1 }) {
  const beta = mach * mach - 1;
  return {
    overpressurePa: pressureFactor * reflectionFactor * Math.sqrt(vehiclePressurePa * groundPressurePa) * beta ** .125 * distanceMetres ** -.75 * lengthMetres ** .75 * shapeFactor,
    durationSeconds: durationFactor * 3.42 / vehicleSoundSpeed * mach / beta ** .375 * distanceMetres ** .25 * lengthMetres ** .75 * shapeFactor
  };
}

/**
 * Where the arrival at a receiver is stationary along a path sampled every `path.step` seconds
 * (`seconds`, `x`, `y`, `z`): each minimum of T(t) = t + travel(x(t) → receiver) between its ends,
 * outside the refraction shadow, with the ray from there and T″. The receiver is in the frame of
 * the path (heights above the datum).
 */
export function stationaryArrivals(path, receiver, profile) {
  const count = path.seconds.length;
  if (count < 3) return [];
  const arrival = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const point = { x: path.x[index], y: path.y[index], z: path.z[index] };
    arrival[index] = path.seconds[index] + travelSeconds(pathProfile(profile, point, receiver), point, receiver);
  }
  const found = [];
  const h = path.step;
  for (let index = 1; index < count - 1; index += 1) {
    if (!(arrival[index] < arrival[index - 1] && arrival[index] <= arrival[index + 1])) continue;
    // The minimum between the samples, by a parabola through the three.
    const curvature = (arrival[index + 1] - 2 * arrival[index] + arrival[index - 1]) / (h * h);
    const shift = curvature > 0 ? Math.max(-.5, Math.min(.5, (arrival[index - 1] - arrival[index + 1]) / (2 * curvature * h * h))) : 0;
    const blend = values => values[index] + (shift >= 0 ? (values[index + 1] - values[index]) * shift : (values[index] - values[index - 1]) * shift);
    const point = { x: blend(path.x), y: blend(path.y), z: blend(path.z) };
    const along = pathProfile(profile, point, receiver);
    if (along.gradient < 0 && inShadow(along, point, receiver)) continue;
    found.push({ point, emissionSeconds: blend(path.seconds), ray: rayBetween(along, point, receiver), along, curvature, blend });
  }
  return found;
}

/**
 * The booms of a flight path at a receiver: where each leaves the path, when, along which ray, with
 * its free-field overpressure and duration there and its focusing. The receiver is in the frame of
 * the path (heights above the datum).
 */
export function flightBooms(path, flight, receiver, profile, air) {
  const booms = [];
  for (const { point, emissionSeconds, ray, along, curvature, blend } of stationaryArrivals(path, receiver, profile)) {
    const speed = blend(path.speed);
    const soundSpeed = soundSpeedAt(air, point.z);
    const mach = speed / soundSpeed;
    if (!(mach > 1)) continue;
    const boom = carlsonBoom({
      mach, vehiclePressurePa: pressureAtHeightPa(air, point.z), groundPressurePa: pressureAtHeightPa(air, Math.max(0, receiver.z)),
      vehicleSoundSpeed: soundSpeed, lengthMetres: flight.lengthMetres, shapeFactor: flight.shapeFactor, distanceMetres: ray.metres
    });
    // Steady straight flight at this Mach number and distance: T″ = v²(1 − 1/M²)/(c·r), c the ray's mean speed.
    const meanSpeed = ray.metres / Math.max(ray.seconds, 1e-9);
    const steady = speed * speed * (1 - 1 / (mach * mach)) / (meanSpeed * ray.metres);
    const focus = Math.min(FOCUS_LIMIT, Math.sqrt(steady / Math.max(curvature, steady / FOCUS_LIMIT ** 2)));
    booms.push({ point, emissionSeconds, ray, along, mach, focus, ...boom });
  }
  return booms;
}

/** Fronts of a body's past that its Mach cone is drawn through, and points around each. */
const CONE_RINGS = 16;
const CONE_RING_POINTS = 32;

/**
 * A body's Mach cone at the clock, as the envelope of the fronts it has left (for views): on the
 * front from each of CONE_RINGS past points of its path, the circle that the rays leaving at
 * cos α = c/v to its flight reach, with the fronts' refraction. Where it flew no faster than sound
 * it leaves no ring. The apex is the body while it flies.
 */
export function machCone(path, now, profile) {
  const count = path.seconds.length;
  const last = Math.min(count - 1, Math.floor((now - path.seconds[0]) / path.step));
  if (last < 1) return null;
  const at = index => ({ x: path.x[index], y: path.y[index], z: path.z[index] });
  const rings = [];
  for (let ring = 1; ring <= CONE_RINGS; ring += 1) {
    const index = Math.round(last * (1 - ring / CONE_RINGS));
    const before = at(Math.max(0, index - 1));
    const after = at(Math.min(count - 1, index + 1));
    const span = (Math.min(count - 1, index + 1) - Math.max(0, index - 1)) * path.step;
    const d = { x: after.x - before.x, y: after.y - before.y, z: after.z - before.z };
    const length = Math.hypot(d.x, d.y, d.z);
    const point = at(index);
    const cosine = speedAt(profile, point.z) / (length / span);
    if (!(length > 0 && cosine < 1)) continue;
    const unit = { x: d.x / length, y: d.y / length, z: d.z / length };
    // Two directions across the flight.
    const across = Math.abs(unit.z) < .9 ? { x: unit.y, y: -unit.x, z: 0 } : { x: 0, y: unit.z, z: -unit.y };
    const norm = Math.hypot(across.x, across.y, across.z);
    const first = { x: across.x / norm, y: across.y / norm, z: across.z / norm };
    const second = { x: unit.y * first.z - unit.z * first.y, y: unit.z * first.x - unit.x * first.z, z: unit.x * first.y - unit.y * first.x };
    const { centre, radiusMetres } = wavefront(profile, point, now - path.seconds[index]);
    const middle = { x: centre.x + radiusMetres * cosine * unit.x, y: centre.y + radiusMetres * cosine * unit.y, z: centre.z + radiusMetres * cosine * unit.z };
    const radius = radiusMetres * Math.sqrt(1 - cosine * cosine);
    rings.push(Array.from({ length: CONE_RING_POINTS }, (_, step) => {
      const angle = 2 * Math.PI * step / CONE_RING_POINTS;
      const a = radius * Math.cos(angle);
      const b = radius * Math.sin(angle);
      return { x: middle.x + a * first.x + b * second.x, y: middle.y + a * first.y + b * second.y, z: middle.z + a * first.z + b * second.z };
    }));
  }
  if (!rings.length) return null;
  const flying = (now - path.seconds[0]) / path.step <= count - 1;
  return { apex: flying ? at(last) : null, rings };
}
