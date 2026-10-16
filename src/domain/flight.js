import { BOOSTER, FLIGHT, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED, VIEW, WHIP } from './constants.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from '../shared/domain/air.js';
import { inShadow, localProfile, pathProfile, rayBetween, shadowPath, speedAt, travelSeconds, wavefront } from '../shared/domain/refraction.js';
import { onGround } from '../shared/domain/terrain.js';
import { soundSpeedAt } from '../shared/domain/trajectory.js';

/** Booms where the arrival is stationary, class A; Carlson's simplified method (NASA TP-1122, 1978), class B with K_p = K_t = 1 class C; focusing class B, its limit class C. */

export const BODY_TYPES = Object.freeze(Object.keys(FLIGHT.bodies));

/** Class C as a pattern. */
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


const CONE_RING = Object.freeze(Array.from({ length: VIEW.cone.ringPoints }, (_, step) => {
  const angle = 2 * Math.PI * step / VIEW.cone.ringPoints;
  return Object.freeze({ cos: Math.cos(angle), sin: Math.sin(angle) });
}));

export function whipPath(whip, air, surface = null) {
  const climb = whip.climbDegrees * Math.PI / 180;
  const heading = whip.headingDegrees * Math.PI / 180;
  const along = { x: Math.cos(climb) * Math.sin(heading), y: Math.cos(climb) * Math.cos(heading), z: Math.sin(climb) };
  const upright = Math.abs(along.z) < .999 ? { x: -along.z * along.x, y: -along.z * along.y, z: 1 - along.z * along.z } : { x: Math.sin(heading), y: Math.cos(heading), z: 0 };
  const norm = Math.hypot(upright.x, upright.y, upright.z);
  const over = { x: upright.x / norm, y: upright.y / norm, z: upright.z / norm };
  const sound = soundSpeedAt(air, whip.startMetres.z);
  const start = surface ? onGround(surface, whip.startMetres) : whip.startMetres;
  const radius = WHIP.turnRadiusMetres;
  const slow = WHIP.subsonicMach * sound;
  const top = Math.max(whip.mach * sound, slow * 1.001);
  const knee = Math.min(sound, top);
  const even = (from, to, metres) => [2 * metres / (from + to), (to * to - from * from) / (2 * metres)];
  const parts = [];
  const straight = (from, to, metres, sign) => { const [seconds, rate] = even(from, to, metres); parts.push({ kind: 'line', seconds, from, rate, metres, sign }); };
  straight(slow, knee, WHIP.subsonicMetres, 1);
  if (top > sound) straight(sound, top, WHIP.accelerationMetres, 1);
  parts.push({ kind: 'turn', seconds: Math.PI * radius / top, speed: top });
  if (top > sound) straight(top, sound, WHIP.decelerationMetres, -1);
  straight(Math.min(top, sound), slow, WHIP.subsonicMetres, -1);
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

export function boosterPath(booster, air, surface = null) {
  const pad = surface ? onGround(surface, booster.padMetres) : booster.padMetres;
  const heading = booster.headingDegrees * Math.PI / 180;
  const descent = booster.descentDegrees * Math.PI / 180;
  const density = z => pressureAtHeightPa(air, z) / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, Math.max(0, z)));
  const drag = .5 / booster.ballisticKilogramsPerSquareMetre;
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

export const whipBody = whip => ({ lengthMetres: whip.crackerLengthMetres, shapeFactor: whip.crackerShapeFactor });

export function carlsonBoom({ mach, vehiclePressurePa, groundPressurePa, vehicleSoundSpeed, lengthMetres, shapeFactor, distanceMetres, pressureFactor = 1, durationFactor = 1, reflectionFactor = 1 }) {
  const beta = mach * mach - 1;
  return {
    overpressurePa: pressureFactor * reflectionFactor * Math.sqrt(vehiclePressurePa * groundPressurePa) * beta ** .125 * distanceMetres ** -.75 * lengthMetres ** .75 * shapeFactor,
    durationSeconds: durationFactor * 3.42 / vehicleSoundSpeed * mach / beta ** .375 * distanceMetres ** .25 * lengthMetres ** .75 * shapeFactor
  };
}

/** Shadow paths class B/C, as a point source's. */
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
    const meanSpeed = ray.metres / Math.max(ray.seconds, 1e-9);
    const steady = speed * speed * (1 - 1 / (mach * mach)) / (meanSpeed * ray.metres);
    const focus = Math.min(FLIGHT.focusLimit, Math.sqrt(steady / Math.max(curvature, steady / FLIGHT.focusLimit ** 2)));
    booms.push({ point, emissionSeconds, ray, along, mach, focus, shadow, ...boom });
  }
  return booms;
}

export function machCone(path, now, profile) {
  const count = path.seconds.length;
  const last = Math.min(count - 1, Math.floor((now - path.seconds[0]) / path.step));
  if (last < 1) return null;
  const at = index => ({ x: path.x[index], y: path.y[index], z: path.z[index] });
  const speedAround = index => {
    const from = Math.max(0, index - 1);
    const to = Math.min(count - 1, index + 1);
    return Math.hypot(path.x[to] - path.x[from], path.y[to] - path.y[from], path.z[to] - path.z[from]) / ((to - from) * path.step);
  };
  const supersonic = index => speedAround(index) > speedAt(localProfile(profile, path.z[index]), path.z[index]);
  let end = last;
  while (end > 0 && !supersonic(end)) end -= 1;
  if (end < 1) return null;
  const flying = (now - path.seconds[0]) / path.step <= count - 1;
  const apex = flying && end === last;
  const rings = [];
  const radii = [];
  for (let ring = apex ? 1 : 0; ring <= VIEW.cone.rings; ring += 1) {
    const index = Math.round(end * (1 - ring / VIEW.cone.rings));
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
    const across = Math.abs(unit.z) < .9 ? { x: unit.y, y: -unit.x, z: 0 } : { x: 0, y: unit.z, z: -unit.y };
    const norm = Math.hypot(across.x, across.y, across.z);
    const first = { x: across.x / norm, y: across.y / norm, z: across.z / norm };
    const second = { x: unit.y * first.z - unit.z * first.y, y: unit.z * first.x - unit.x * first.z, z: unit.x * first.y - unit.y * first.x };
    const { centre, radiusMetres } = wavefront(local, point, now - path.seconds[index]);
    const middle = { x: centre.x + radiusMetres * cosine * unit.x, y: centre.y + radiusMetres * cosine * unit.y, z: centre.z + radiusMetres * cosine * unit.z };
    const radius = radiusMetres * Math.sqrt(1 - cosine * cosine);
    radii.push(radiusMetres);
    rings.push(CONE_RING.map(({ cos, sin }) => {
      const a = radius * cos;
      const b = radius * sin;
      return { x: middle.x + a * first.x + b * second.x, y: middle.y + a * first.y + b * second.y, z: middle.z + a * first.z + b * second.z };
    }));
  }
  if (!rings.length) return null;
  return { apex: apex ? at(last) : null, rings, radii };
}
