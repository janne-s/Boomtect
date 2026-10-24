import { BOOSTER, FLIGHT, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED, WHIP } from './constants.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from '../shared/domain/air.js';
import { inShadow, pathProfile, rayBetween, shadowPath, travelSeconds } from '../shared/domain/refraction.js';
import { onGround } from '../shared/domain/terrain.js';
import { formationMembers, soundSpeedAt } from '../shared/domain/trajectory.js';
import { foldScaling, FOCUS_RANGE } from '../shared/domain/focus.js';

/** Booms where the arrival is stationary, class A; Carlson's simplified method (NASA TP-1122, 1978), class B with K_p = K_t = 1 class C; focusing class B, its limit class C. */

export const BODY_TYPES = Object.freeze(Object.keys(FLIGHT.bodies));

export const flightMembers = emitter => (emitter.kind === 'formation' ? formationMembers(emitter, emitter.memberCount, emitter.lateralSpacingMetres, emitter.trailSpacingMetres) : [emitter]);



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

function arrivalTimes(path, receiver, profile) {
  return Float64Array.from(path.seconds, (seconds, index) => {
    const point = { x: path.x[index], y: path.y[index], z: path.z[index] };
    return seconds + travelSeconds(pathProfile(profile, point, receiver), point, receiver);
  });
}

function stationaryPoint(path, arrival, index, receiver, profile) {
  const h = path.step;
  const curvature = (arrival[index + 1] - 2 * arrival[index] + arrival[index - 1]) / (h * h);
  const shift = curvature !== 0 ? Math.max(-.5, Math.min(.5, (arrival[index - 1] - arrival[index + 1]) / (2 * curvature * h * h))) : 0;
  const blend = values => values[index] + (shift >= 0 ? (values[index + 1] - values[index]) * shift : (values[index] - values[index - 1]) * shift);
  const point = { x: blend(path.x), y: blend(path.y), z: blend(path.z) };
  const along = pathProfile(profile, point, receiver);
  const shadow = along.gradient < 0 && inShadow(along, point, receiver);
  return { point, emissionSeconds: blend(path.seconds), ray: shadow ? shadowPath(along, point, receiver) : rayBetween(along, point, receiver), along, curvature, blend, shadow };
}

/**
 * The arrival time's stationary points, minima and maxima, and its folds: where its slope has an extremum, the two
 * arrivals either side meet at a caustic. Class C.
 */
function arrivalStructure(path, receiver, profile) {
  const count = path.seconds.length;
  if (count < 3) return { stationary: [], folds: [] };
  const h = path.step;
  const arrival = arrivalTimes(path, receiver, profile);
  const w = Math.max(1, Math.min(Math.round(FLIGHT.slopeSeconds / h), Math.floor(count / 100)));
  const slope = Float64Array.from(arrival, (_, index) => {
    const low = Math.max(0, index - w);
    const high = Math.min(count - 1, index + w);
    return (arrival[high] - arrival[low]) / ((high - low) * h);
  });
  const stationary = [];
  for (let index = 0; index + 1 < count; index += 1) {
    if (Math.sign(slope[index]) === Math.sign(slope[index + 1]) || slope[index + 1] === 0) continue;
    const minimum = slope[index] < 0;
    let best = -1;
    for (let at = Math.max(1, index - w); at <= Math.min(count - 2, index + 1 + w); at += 1) {
      if (best < 0 || (minimum ? arrival[at] < arrival[best] : arrival[at] > arrival[best])) best = at;
    }
    if (best < 0) continue;
    const isExtreme = minimum ? arrival[best] < arrival[best - 1] && arrival[best] <= arrival[best + 1] : arrival[best] > arrival[best - 1] && arrival[best] >= arrival[best + 1];
    if (isExtreme) stationary.push({ index: best, maximum: !minimum });
  }
  const folds = [];
  for (let index = 1; index + 1 < count; index += 1) {
    const isFold = (slope[index] < slope[index - 1] && slope[index] <= slope[index + 1]) || (slope[index] > slope[index - 1] && slope[index] >= slope[index + 1]);
    if (!isFold) continue;
    let reach = 2 * w;
    let change = 0;
    while (index - reach >= 0 && index + reach < count) {
      change = (slope[index + reach] + slope[index - reach]) / 2 - slope[index];
      if (Math.abs(change) >= FLIGHT.foldSlopeChange) break;
      reach *= 2;
    }
    if (!(Math.abs(change) >= FLIGHT.foldSlopeChange)) continue;
    folds.push({ index, slope: slope[index], third: 2 * change / (reach * h) ** 2 });
    index += reach;
  }
  return { arrival, stationary, folds };
}

function boomAt(path, flight, receiver, air, { point, ray, along }, speed) {
  const soundSpeed = soundSpeedAt(air, point.z);
  const mach = speed / soundSpeed;
  if (!(mach > 1)) return null;
  const boom = carlsonBoom({
    mach, vehiclePressurePa: pressureAtHeightPa(air, point.z), groundPressurePa: pressureAtHeightPa(air, Math.max(0, receiver.z)),
    vehicleSoundSpeed: soundSpeed, lengthMetres: flight.lengthMetres, shapeFactor: flight.shapeFactor, distanceMetres: ray.metres
  });
  const meanSpeed = ray.metres / Math.max(ray.seconds, 1e-9);
  const steady = speed * speed * (1 - 1 / (mach * mach)) / (meanSpeed * ray.metres);
  return { mach, soundSpeed, steady, ...boom };
}

/** A fold near the receiver as one focused boom from the nonlinear Tricomi table (tect-shared focus.js), class B; the matching to the rays class C. */
function focusedBoom(path, flight, receiver, profile, air, arrival, fold) {
  const { index } = fold;
  const point = { x: path.x[index], y: path.y[index], z: path.z[index] };
  const along = pathProfile(profile, point, receiver);
  const shadow = along.gradient < 0 && inShadow(along, point, receiver);
  const ray = shadow ? shadowPath(along, point, receiver) : rayBetween(along, point, receiver);
  const speed = path.speed[index];
  const boom = boomAt(path, flight, receiver, air, { point, ray, along }, speed);
  if (!boom) return null;
  const halfSeconds = boom.durationSeconds / 2;
  const scaling = foldScaling({
    slope: fold.slope, third: fold.third, halfSeconds, flatPa: boom.overpressurePa, steadyCurvature: boom.steady,
    slopeGradient: Math.sqrt(Math.max(0, speed * speed - boom.soundSpeed ** 2)) / (boom.soundSpeed * ray.metres),
    groundPressurePa: pressureAtHeightPa(air, Math.max(0, receiver.z)), groundSoundSpeed: soundSpeedAt(air, Math.max(0, receiver.z))
  });
  if (!scaling) return null;
  const cubic = Math.abs(fold.third) / 2;
  const reachSeconds = Math.sqrt(Math.max(0, -fold.slope * Math.sign(fold.third)) / cubic);
  const share = Math.max(0, Math.min(1, (FOCUS_RANGE.highest - scaling.height) / FLIGHT.focusBlendHeight));
  return {
    index, reachSeconds, share,
    boom: scaling.height >= FOCUS_RANGE.lowest && share > 0 ? {
      point, emissionSeconds: arrival[index] - ray.seconds + FOCUS_RANGE.startTau * halfSeconds, ray, along, mach: boom.mach, focus: share, shadow,
      overpressurePa: scaling.referencePa, durationSeconds: boom.durationSeconds, focusMu: scaling.mu, focusHeight: scaling.height
    } : null
  };
}

/**
 * Booms where the arrival is stationary: the earlier, a minimum, as an N-wave, the later, a maximum that has touched
 * its caustic, turned by a quarter period into a U-wave; near a fold both come from the focused boom instead. Without
 * `caustics` only the minima boom, as a whip's crack, whose weak-shock caustic would be centimetres from its tip.
 */
export function flightBooms(path, flight, receiver, profile, air, { caustics = true } = {}) {
  const structure = arrivalStructure(path, receiver, profile);
  const { arrival } = structure;
  const stationary = caustics ? structure.stationary : structure.stationary.filter(point => !point.maximum);
  const folds = caustics ? structure.folds : [];
  const booms = [];
  const rayShares = new Map();
  const ordered = [...stationary].sort((first, second) => first.index - second.index);
  const pairs = [];
  ordered.forEach((point, position) => {
    const next = ordered[position + 1];
    if (next && point.maximum !== next.maximum) pairs.push([point, next]);
  });
  // A pair either side of a fold gives it from its own timing: s₀ half their spacing, |a| = Δt / 4s₀³, b = 3|a|s₀².
  const fromPairs = pairs.map(([first, second]) => {
    const spread = (second.index - first.index) * path.step / 2;
    const cubic = Math.abs(arrival[second.index] - arrival[first.index]) / (4 * spread ** 3);
    const sign = first.maximum ? 1 : -1;
    return { index: Math.round((first.index + second.index) / 2), slope: -3 * cubic * spread ** 2 * sign, third: 6 * cubic * sign, pair: [first, second] };
  });
  // Without a pair a fold can only be the shadow side's, where the arrival comes near stationary without reaching it.
  const lone = folds.filter(fold => !fromPairs.some(({ pair: [first, second] }) => fold.index >= first.index && fold.index <= second.index)
    && fold.slope * Math.sign(fold.third) > 0 && Math.abs(fold.slope) <= FLIGHT.shadowFoldSlope);
  for (const fold of [...fromPairs, ...lone]) {
    const focused = focusedBoom(path, flight, receiver, profile, air, arrival, fold);
    if (!focused?.boom) continue;
    booms.push(focused.boom);
    const reach = 1.5 * focused.reachSeconds + 2 * Math.min(FLIGHT.slopeSeconds, path.seconds.length * path.step / 100);
    for (const point of fold.pair ?? stationary.filter(item => Math.abs(item.index - fold.index) * path.step <= reach)) rayShares.set(point, 1 - focused.share);
  }
  for (const stationaryIndex of stationary) {
    const rayShare = rayShares.get(stationaryIndex) ?? 1;
    if (!(rayShare > 0)) continue;
    const found = stationaryPoint(path, arrival, stationaryIndex.index, receiver, profile);
    const speed = found.blend(path.speed);
    const boom = boomAt(path, flight, receiver, air, found, speed);
    if (!boom) continue;
    const focus = rayShare * Math.min(FLIGHT.focusLimit, Math.sqrt(boom.steady / Math.max(Math.abs(found.curvature), boom.steady / FLIGHT.focusLimit ** 2)));
    const { mach, overpressurePa, durationSeconds } = boom;
    booms.push({ point: found.point, emissionSeconds: found.emissionSeconds, ray: found.ray, along: found.along, mach, focus, shadow: found.shadow, overpressurePa, durationSeconds, ...(stationaryIndex.maximum ? { hilbert: true } : {}) });
  }
  return booms;
}

