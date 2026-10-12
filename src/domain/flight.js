import { BOOSTER, FLIGHT, GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED, VIEW, WHIP } from './constants.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from './air.js';
import { inShadow, localProfile, pathProfile, rayBetween, shadowPath, speedAt, travelSeconds, wavefront } from './refraction.js';
import { onGround } from './terrain.js';

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
 * converge: the boom grows as √(T″ of straight, steady flight / T″), up to FLIGHT.focusLimit (class B for
 * the stationary-phase law, class C for the limit, where ray theory fails at a caustic).
 */

export const BODY_TYPES = Object.freeze(Object.keys(FLIGHT.bodies));

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
 * A whip's tip (WHIP): it speeds up along its heading and climb, reaching the speed of sound at its
 * start and its top Mach number after, turns around over the top on a half circle, and slows down
 * going back, at even rates along each straight part. A whip whose top speed is not supersonic
 * turns at that speed and does not crack. Its start is above the ground of `surface`.
 * Positions, times, and velocities every WHIP.stepSeconds, as `flightPath`.
 */
export function whipPath(whip, air, surface = null) {
  const climb = whip.climbDegrees * Math.PI / 180;
  const heading = whip.headingDegrees * Math.PI / 180;
  const along = { x: Math.cos(climb) * Math.sin(heading), y: Math.cos(climb) * Math.cos(heading), z: Math.sin(climb) };
  // The turn's other axis: up, square to the heading (or the heading's horizontal for a vertical throw).
  const upright = Math.abs(along.z) < .999 ? { x: -along.z * along.x, y: -along.z * along.y, z: 1 - along.z * along.z } : { x: Math.sin(heading), y: Math.cos(heading), z: 0 };
  const norm = Math.hypot(upright.x, upright.y, upright.z);
  const over = { x: upright.x / norm, y: upright.y / norm, z: upright.z / norm };
  const sound = soundSpeedAt(air, whip.startMetres.z);
  const start = surface ? onGround(surface, whip.startMetres) : whip.startMetres;
  const radius = WHIP.turnRadiusMetres;
  const slow = WHIP.subsonicMach * sound;
  // Up to its top speed the tip only speeds up: from the subsonic lead to sound, then on to the top.
  const top = Math.max(whip.mach * sound, slow * 1.001);
  const knee = Math.min(sound, top);
  // Straight parts at an even rate from one speed to another over a distance, as [seconds, rate].
  const even = (from, to, metres) => [2 * metres / (from + to), (to * to - from * from) / (2 * metres)];
  const parts = [];
  const straight = (from, to, metres, sign) => { const [seconds, rate] = even(from, to, metres); parts.push({ kind: 'line', seconds, from, rate, metres, sign }); };
  straight(slow, knee, WHIP.subsonicMetres, 1);
  if (top > sound) straight(sound, top, WHIP.accelerationMetres, 1);
  parts.push({ kind: 'turn', seconds: Math.PI * radius / top, speed: top });
  if (top > sound) straight(top, sound, WHIP.decelerationMetres, -1);
  straight(Math.min(top, sound), slow, WHIP.subsonicMetres, -1);
  // Each part starts where the last ended, in the plane of the heading and the turn's axis (a, b).
  let position = { a: -WHIP.subsonicMetres, b: 0 };
  let time = 0;
  for (const part of parts) {
    part.start = time;
    part.origin = position;
    if (part.kind === 'line') position = { a: position.a + part.sign * part.metres, b: position.b };
    else position = { a: position.a, b: position.b + 2 * radius };
    time += part.seconds;
  }
  const at = t => {
    const part = parts.find(item => t <= item.start + item.seconds) ?? parts.at(-1);
    const u = Math.min(t - part.start, part.seconds);
    if (part.kind === 'turn') {
      const angle = u * part.speed / radius;
      return { a: part.origin.a + radius * Math.sin(angle), b: part.origin.b + radius * (1 - Math.cos(angle)), va: part.speed * Math.cos(angle), vb: part.speed * Math.sin(angle), speed: part.speed };
    }
    const speed = part.from + part.rate * u;
    return { a: part.origin.a + part.sign * (part.from * u + part.rate * u * u / 2), b: part.origin.b, va: part.sign * speed, vb: 0, speed };
  };
  const steps = Math.max(2, Math.ceil(time / WHIP.stepSeconds));
  const step = time / steps;
  // Its start time is when the tip reaches the speed of sound, or would.
  const sonic = parts[0].seconds;
  const path = { seconds: [], x: [], y: [], z: [], vx: [], vy: [], vz: [], speed: [], step };
  for (let index = 0; index <= steps; index += 1) {
    const { a, b, va, vb, speed } = at(index * step);
    path.seconds.push(whip.startSeconds + index * step - sonic);
    path.x.push(start.x + a * along.x + b * over.x);
    path.y.push(start.y + a * along.y + b * over.y);
    path.z.push(start.z + a * along.z + b * over.z);
    path.vx.push(va * along.x + vb * over.x);
    path.vy.push(va * along.y + vb * over.y);
    path.vz.push(va * along.z + vb * over.z);
    path.speed.push(speed);
  }
  return path;
}

/**
 * A booster's fall to its pad (BOOSTER): from its start height at its Mach number and descent angle
 * below the horizontal, along its heading, under gravity and drag in the layered air, until it
 * reaches the ground under its pad. The path is set sideways so that it ends at the pad, on the
 * ground of `surface`. Positions, times, and velocities every BOOSTER.stepSeconds, as `flightPath`.
 */
export function boosterPath(booster, air, surface = null) {
  const pad = surface ? onGround(surface, booster.padMetres) : booster.padMetres;
  const heading = booster.headingDegrees * Math.PI / 180;
  const descent = booster.descentDegrees * Math.PI / 180;
  const density = z => pressureAtHeightPa(air, z) / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, Math.max(0, z)));
  const drag = .5 / booster.ballisticKilogramsPerSquareMetre;
  // The state along the heading and up: [a, z, va, vz], stepped by the classical Runge–Kutta method.
  const rate = ([, z, va, vz]) => {
    const pull = drag * density(z) * Math.hypot(va, vz);
    return [va, vz, -pull * va, -pull * vz - STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED];
  };
  const add = (state, slope, scale) => state.map((value, index) => value + slope[index] * scale);
  const h = BOOSTER.stepSeconds;
  const speed0 = booster.mach * soundSpeedAt(air, booster.startHeightMetres);
  let state = [0, booster.startHeightMetres, speed0 * Math.cos(descent), -speed0 * Math.sin(descent)];
  const states = [state];
  for (let step = 0; step * h < BOOSTER.maximumSeconds && state[1] > pad.z; step += 1) {
    const k1 = rate(state);
    const k2 = rate(add(state, k1, h / 2));
    const k3 = rate(add(state, k2, h / 2));
    const k4 = rate(add(state, k3, h));
    state = state.map((value, index) => value + h / 6 * (k1[index] + 2 * k2[index] + 2 * k3[index] + k4[index]));
    states.push(state);
  }
  // The last step ends where it reaches the pad's height, between the last two steps (its time is rounded to the step).
  const last = states.at(-1);
  const before = states.at(-2) ?? last;
  const share = last[1] < pad.z && before[1] > last[1] ? (before[1] - pad.z) / (before[1] - last[1]) : 1;
  states[states.length - 1] = before.map((value, index) => value + (last[index] - value) * share);
  const end = states.at(-1)[0];
  const path = { seconds: [], x: [], y: [], z: [], vx: [], vy: [], vz: [], speed: [], step: h };
  states.forEach(([a, z, va, vz], index) => {
    const along = a - end;
    path.seconds.push(booster.startSeconds + index * h);
    path.x.push(pad.x + along * Math.sin(heading)); path.y.push(pad.y + along * Math.cos(heading)); path.z.push(z);
    path.vx.push(va * Math.sin(heading)); path.vy.push(va * Math.cos(heading)); path.vz.push(vz); path.speed.push(Math.hypot(va, vz));
  });
  return path;
}

/** A whip's cracker as the body whose boom `flightBooms` finds. */
export const whipBody = whip => ({ lengthMetres: whip.crackerLengthMetres, shapeFactor: whip.crackerShapeFactor });

/**
 * The flight path with its approach before the start: a body supersonic at its start has been flying
 * before it, so its booms near the start left from there (FLIGHT.approachHeights). A subsonic start
 * has none. Views draw the path from the start.
 */
export function withApproach(path, air) {
  const speed = path.speed[0];
  const mach = speed / soundSpeedAt(air, path.z[0]);
  if (!(mach > 1)) return path;
  const metres = FLIGHT.approachHeights * Math.max(0, path.z[0]) / Math.sqrt(mach * mach - 1) + FLIGHT.approachMetres;
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
 * with the ray from there and T″. Beyond the edge of the boom's carpet, where the air turns the
 * rays away before the ground, the receiver is in the refraction shadow of that point: the ray is
 * then the creeping path into the shadow (`shadowPath`), and `shadow` is set (class B/C, as for a
 * point source's shadow). The receiver is in the frame of the path (heights above the datum).
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
    const shadow = along.gradient < 0 && inShadow(along, point, receiver);
    found.push({ point, emissionSeconds: blend(path.seconds), ray: shadow ? shadowPath(along, point, receiver) : rayBetween(along, point, receiver), along, curvature, blend, shadow });
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
  for (const { point, emissionSeconds, ray, along, curvature, blend, shadow } of stationaryArrivals(path, receiver, profile)) {
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
    const focus = Math.min(FLIGHT.focusLimit, Math.sqrt(steady / Math.max(curvature, steady / FLIGHT.focusLimit ** 2)));
    booms.push({ point, emissionSeconds, ray, along, mach, focus, shadow, ...boom });
  }
  return booms;
}

/**
 * A body's Mach cone at the clock, as the envelope of the fronts it has left (for views): on the
 * front from each of VIEW.cone.rings past points of its path, the circle that the rays leaving at
 * cos α = c/v to its flight reach, with the fronts' refraction. Where it flew no faster than sound
 * it leaves no ring. The apex is the body while it flies. `radii` gives how far each ring's front
 * has spread from where it left.
 */
export function machCone(path, now, profile) {
  const count = path.seconds.length;
  const last = Math.min(count - 1, Math.floor((now - path.seconds[0]) / path.step));
  if (last < 1) return null;
  const at = index => ({ x: path.x[index], y: path.y[index], z: path.z[index] });
  const rings = [];
  const radii = [];
  for (let ring = 1; ring <= VIEW.cone.rings; ring += 1) {
    const index = Math.round(last * (1 - ring / VIEW.cone.rings));
    const before = at(Math.max(0, index - 1));
    const after = at(Math.min(count - 1, index + 1));
    const span = (Math.min(count - 1, index + 1) - Math.max(0, index - 1)) * path.step;
    const d = { x: after.x - before.x, y: after.y - before.y, z: after.z - before.z };
    const length = Math.hypot(d.x, d.y, d.z);
    const point = at(index);
    const local = localProfile(profile, point.z);
    const cosine = speedAt(local, point.z) / (length / span);
    if (!(length > 0 && cosine < 1)) continue;
    const unit = { x: d.x / length, y: d.y / length, z: d.z / length };
    // Two directions across the flight.
    const across = Math.abs(unit.z) < .9 ? { x: unit.y, y: -unit.x, z: 0 } : { x: 0, y: unit.z, z: -unit.y };
    const norm = Math.hypot(across.x, across.y, across.z);
    const first = { x: across.x / norm, y: across.y / norm, z: across.z / norm };
    const second = { x: unit.y * first.z - unit.z * first.y, y: unit.z * first.x - unit.x * first.z, z: unit.x * first.y - unit.y * first.x };
    const { centre, radiusMetres } = wavefront(local, point, now - path.seconds[index]);
    const middle = { x: centre.x + radiusMetres * cosine * unit.x, y: centre.y + radiusMetres * cosine * unit.y, z: centre.z + radiusMetres * cosine * unit.z };
    const radius = radiusMetres * Math.sqrt(1 - cosine * cosine);
    radii.push(radiusMetres);
    rings.push(Array.from({ length: VIEW.cone.ringPoints }, (_, step) => {
      const angle = 2 * Math.PI * step / VIEW.cone.ringPoints;
      const a = radius * Math.cos(angle);
      const b = radius * Math.sin(angle);
      return { x: middle.x + a * first.x + b * second.x, y: middle.y + a * first.y + b * second.y, z: middle.z + a * first.z + b * second.z };
    }));
  }
  if (!rings.length) return null;
  const flying = (now - path.seconds[0]) / path.step <= count - 1;
  return { apex: flying ? at(last) : null, rings, radii };
}
