import { speedOfSoundMetresPerSecond, temperatureAtHeightKelvin, temperatureLayers } from './air.js';
import { AIR, GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, PROPAGATION, VIEW } from './constants.js';

/** Class A for the given profile (Červený 2000, as quoted in arXiv 2003.11418); the profile's fit class B. */

const FLAT_GRADIENT = 1e-12;
const RIGID_CREEPING_ZERO = 1.0187929716;
const ROOT_ITERATIONS = 100;
const ROOT_TOLERANCE_METRES = 1e-11;
const BRANCH_SCAN_STEPS = 64;
const HALF_PI = Math.PI / 2;
const ROUNDING = 1e-12;

export const PATH_DIRECT = 0;
export const PATH_GROUND = 1;
export const PATH_SHADOW = 2;
export const PATH_ECHO = 3;
export const PATH_SCATTER = 4;

export function soundSpeedProfile(air) {
  const groundSpeed = speedOfSoundMetresPerSecond(air.temperatureCelsius);
  if (!air.refraction) return { groundSpeed, gradient: 0 };
  const fitHeight = air.groundLayerMetres > 0 ? air.groundLayerMetres : AIR.profileFitHeightMetres;
  const trueSpeed = height => Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, height));
  const gradient = (trueSpeed(fitHeight) - groundSpeed) / fitHeight;
  const breaks = temperatureLayers(air).map(layer => layer.top).filter(Number.isFinite);
  const layered = { fitHeight, trueSpeed, breaks };
  if (!air.windSpeedMetresPerSecond && !air.windShearPerSecond) return { groundSpeed, gradient, layered };
  // Wind from a compass bearing blows toward the opposite one: from the north (0°) toward −y.
  const bearing = air.windFromDegrees * Math.PI / 180;
  const toward = { x: -Math.sin(bearing), y: -Math.cos(bearing) };
  return {
    groundSpeed,
    gradient,
    layered,
    wind: { x: toward.x * air.windSpeedMetresPerSecond, y: toward.y * air.windSpeedMetresPerSecond },
    shear: { x: toward.x * air.windShearPerSecond, y: toward.y * air.windShearPerSecond }
  };
}

const GAUSS_NODES = [.0198550717512319, .1016667612931866, .2372337950418355, .4082826787521751, .5917173212478249, .7627662049581645, .8983332387068134, .9801449282487681];
const GAUSS_WEIGHTS = [.0506142681451881, .1111905172266872, .1568533229389436, .1813418916891810, .1813418916891810, .1568533229389436, .1111905172266872, .0506142681451881];
const SLOWNESS_ITERATIONS = 30;

/** Class C. */
export function pathProfile(profile, a, b) {
  const top = Math.max(a.z, b.z);
  if (!profile.layered || !(top > profile.layered.fitHeight)) return alongProfile(profile, b.x - a.x, b.y - a.y);
  const bottom = Math.max(0, Math.min(a.z, b.z));
  const span = top - bottom;
  const c0 = profile.groundSpeed;
  const edges = [bottom, ...profile.layered.breaks.filter(height => height > bottom && height < top), top];
  let target = 0;
  for (let piece = 1; piece < edges.length; piece += 1) {
    const width = edges[piece] - edges[piece - 1];
    for (let node = 0; node < GAUSS_NODES.length; node += 1) target += width * GAUSS_WEIGHTS[node] / profile.layered.trueSpeed(edges[piece - 1] + width * GAUSS_NODES[node]);
  }
  target /= span;
  let gradient = (profile.layered.trueSpeed(top) - c0) / top;
  for (let iteration = 0; iteration < SLOWNESS_ITERATIONS; iteration += 1) {
    const low = c0 + gradient * bottom;
    const high = c0 + gradient * top;
    const small = Math.abs(gradient) * span < 1e-9 * low;
    const mean = small ? 1 / low - gradient * span / (2 * low * low) : Math.log(high / low) / (gradient * span);
    const slope = small ? -span / (2 * low * low) : (top / high - bottom / low) / (gradient * span) - mean / gradient;
    const step = (mean - target) / slope;
    if (!Number.isFinite(step)) break;
    gradient -= step;
    if (Math.abs(step) < 1e-14) break;
  }
  return alongProfile({ ...profile, gradient }, b.x - a.x, b.y - a.y);
}

/** Class B: effective sound speed (Salomons 2001); holds for small Mach numbers and near-horizontal paths. */
export function alongProfile(profile, dx, dy) {
  if (!profile.wind) return profile;
  const horizontal = Math.hypot(dx, dy);
  if (!(horizontal > 0)) return { groundSpeed: profile.groundSpeed, gradient: profile.gradient };
  const nx = dx / horizontal;
  const ny = dy / horizontal;
  return {
    groundSpeed: profile.groundSpeed + profile.wind.x * nx + profile.wind.y * ny,
    gradient: profile.gradient + profile.shear.x * nx + profile.shear.y * ny
  };
}

export const speedAt = (profile, heightMetres) => profile.groundSpeed + profile.gradient * heightMetres;

const flat = profile => Math.abs(profile.gradient) < FLAT_GRADIENT;

function asinhRatio(x) {
  return x < 1e-4 ? 1 - x * x / 6 : Math.asinh(x) / x;
}

function arcRatio(half) {
  return half < 1e-4 ? 1 + half * half / 6 : half / Math.sin(half);
}

export function rayTiming(profile, a, b) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const speedA = speedAt(profile, a.z);
  const speedB = speedAt(profile, b.z);
  const mean = Math.sqrt(speedA * speedB);
  const x = Math.abs(profile.gradient) * distance / (2 * mean);
  return { seconds: distance / mean * asinhRatio(x), spreadMetres: distance * Math.sqrt(speedB / speedA) * Math.sqrt(1 + x * x) };
}

export function rayBetween(profile, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const horizontal = Math.hypot(dx, dy);
  const distance = Math.hypot(horizontal, dz);
  const speedA = speedAt(profile, a.z);
  const speedB = speedAt(profile, b.z);
  const g = profile.gradient;
  const mean = Math.sqrt(speedA * speedB);
  const x = Math.abs(g) * distance / (2 * mean);
  const seconds = distance / mean * asinhRatio(x);
  const spreadMetres = distance * Math.sqrt(speedB / speedA) * Math.sqrt(1 + x * x);
  // Scaled by 2·horizontal·|g| so that they stay finite as g → 0.
  const sum = speedA + speedB;
  const departure = planeDirection(2 * horizontal * speedA, g * horizontal * horizontal + dz * sum, dx, dy, horizontal);
  const arrival = planeDirection(2 * horizontal * speedB, dz * sum - g * horizontal * horizontal, dx, dy, horizontal);
  const cosine = Math.max(-1, Math.min(1, departure.x * arrival.x + departure.y * arrival.y + departure.z * arrival.z));
  const turn = Math.acos(cosine);
  return { seconds, metres: distance * arcRatio(turn / 2), spreadMetres, departure, arrival };
}

function planeDirection(along, up, dx, dy, horizontal) {
  const length = Math.hypot(along, up);
  if (!(length > 0)) return { x: 0, y: 0, z: 1 };
  const h = horizontal > 0 ? along / length / horizontal : 0;
  return { x: dx * h, y: dy * h, z: up / length };
}

export function rayHeightAt(profile, a, b, s) {
  const horizontal = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(horizontal > 0)) return a.z;
  const g = profile.gradient;
  if (flat(profile)) return a.z + (b.z - a.z) * s / horizontal;
  const zStar = -profile.groundSpeed / g;
  const fromA = a.z - zStar;
  const fromB = b.z - zStar;
  const centre = (horizontal * horizontal + fromB * fromB - fromA * fromA) / (2 * horizontal);
  const radius = Math.hypot(centre, fromA);
  return zStar + Math.sign(fromA) * Math.sqrt(Math.max(0, radius * radius - (s - centre) ** 2));
}

/** Fleagle 1949 for small heights. */
export function grazingRange(profile, heightMetres) {
  if (profile.gradient >= 0 || flat(profile)) return Infinity;
  if (heightMetres <= 0) return 0;
  const c0 = profile.groundSpeed;
  const cz = speedAt(profile, heightMetres);
  const sine = Math.sqrt(-profile.gradient * heightMetres / c0 * (1 + cz / c0));
  return heightMetres * (cz + c0) / (c0 * sine);
}

function leg(profile, sinPsi, cosPsi, heightMetres, turned) {
  const c0 = profile.groundSpeed;
  const g = profile.gradient;
  const cz = speedAt(profile, heightMetres);
  const xi = cosPsi / c0;
  const s0 = sinPsi;
  if (heightMetres <= 0) return { metres: 0, derivative: 0, sine: sinPsi };
  const sz2 = sinPsi * sinPsi - cosPsi * cosPsi * (g * heightMetres / c0) * (1 + cz / c0);
  if (sz2 < -ROUNDING) return null;
  const sz = Math.sqrt(Math.max(0, sz2));
  const s0Term = s0 > 0 ? xi * xi * c0 * c0 / s0 : Infinity;
  const szTerm = sz > 0 ? xi * xi * cz * cz / sz : Infinity;
  if (!turned) {
    const sum = s0 + sz;
    if (!(sum > 0)) return { metres: Infinity, derivative: Infinity, sine: sz };
    return {
      metres: xi * heightMetres * (cz + c0) / sum,
      derivative: heightMetres * (cz + c0) * (sum + s0Term + szTerm) / (sum * sum),
      sine: sz
    };
  }
  return { metres: (s0 + sz) / (g * xi), derivative: -(s0Term + szTerm + s0 + sz) / (g * xi * xi), sine: sz };
}

function solveAngle(range, target, low, high) {
  const lowBelow = range(low).metres < target;
  let psi = (low + high) / 2;
  for (let iteration = 0; iteration < ROOT_ITERATIONS; iteration += 1) {
    const { metres, slope } = range(psi);
    const difference = metres - target;
    if (Math.abs(difference) <= ROOT_TOLERANCE_METRES * Math.max(1, target)) return psi;
    if ((difference < 0) === lowBelow) low = psi; else high = psi;
    const step = psi - difference / slope;
    const next = Number.isFinite(step) && step > low && step < high ? step : (low + high) / 2;
    if (next === psi) return psi;
    psi = next;
  }
  return psi;
}

export function reflectedRay(profile, source, receiver) {
  const dx = receiver.x - source.x;
  const dy = receiver.y - source.y;
  const horizontal = Math.hypot(dx, dy);
  const zs = source.z;
  const zr = receiver.z;
  const c0 = profile.groundSpeed;
  if (zs + zr <= 0) return { ...rayBetween(profile, source, receiver), groundSine: 0 };
  if (flat(profile)) return imageRay(profile, source, receiver);
  const g = profile.gradient;
  const higher = Math.max(zs, zr);
  const ratio = speedAt(profile, higher) / c0;
  const lowest = g > 0 && !flat(profile) ? Math.atan(Math.sqrt(Math.max(0, (ratio - 1) * (ratio + 1)))) : 0;
  const pair = (psi, turnedHigher) => {
    const sinPsi = Math.sin(psi);
    const cosPsi = Math.cos(psi);
    const first = leg(profile, sinPsi, cosPsi, zs, turnedHigher && zs >= zr);
    const second = leg(profile, sinPsi, cosPsi, zr, turnedHigher && zr > zs);
    return first && second ? { first, second, sinPsi, cosPsi } : null;
  };
  const range = turned => psi => {
    const legs = pair(psi, turned);
    if (!legs) return { metres: Infinity, slope: NaN };
    return { metres: legs.first.metres + legs.second.metres, slope: -(legs.first.derivative + legs.second.derivative) * legs.sinPsi / c0 };
  };
  let psi;
  let turned = false;
  const monotoneReach = range(false)(lowest).metres;
  if (horizontal <= monotoneReach) {
    psi = solveAngle(range(false), horizontal, lowest, HALF_PI);
  } else {
    if (!(g > 0)) return null;
    turned = true;
    const span = HALF_PI - lowest;
    let previous = lowest;
    psi = null;
    for (let step = 1; step <= BRANCH_SCAN_STEPS; step += 1) {
      const next = lowest + span * (step / BRANCH_SCAN_STEPS) ** 2;
      if (range(true)(next).metres >= horizontal) { psi = solveAngle(range(true), horizontal, previous, next); break; }
      previous = next;
    }
    if (psi === null) return null;
  }
  const legs = pair(psi, turned);
  const unitX = horizontal > 0 ? dx / horizontal : 1;
  const unitY = horizontal > 0 ? dy / horizontal : 0;
  const ground = { x: source.x + unitX * legs.first.metres, y: source.y + unitY * legs.first.metres, z: 0 };
  const down = rayBetween(profile, source, ground);
  const up = rayBetween(profile, ground, receiver);
  const xi = legs.cosPsi / c0;
  const cs = speedAt(profile, zs);
  const derivative = Math.abs(legs.first.derivative + legs.second.derivative);
  const area = horizontal * derivative * legs.first.sine * legs.second.sine / (xi * cs * cs);
  const metres = down.metres + up.metres;
  let spreadMetres = Number.isFinite(area) && area > 0 ? Math.sqrt(area) : horizontal > 0 ? Infinity : metres;
  spreadMetres = Math.max(spreadMetres, metres * 10 ** (-PROPAGATION.causticLimitDb / 20));
  return {
    seconds: down.seconds + up.seconds,
    metres,
    spreadMetres,
    departure: down.departure,
    arrival: up.arrival,
    groundSine: legs.sinPsi,
    groundPoint: ground
  };
}

const BOUNCE_SCAN_STEPS = 48;
const BOUNCE_BISECTIONS = 50;

/** Class A on the profile. */
export function multipleReflections(profile, source, receiver, maximumBounces = PROPAGATION.maximumBounces) {
  const g = profile.gradient;
  if (!(g > 0) || flat(profile) || maximumBounces < 2) return [];
  const dx = receiver.x - source.x;
  const dy = receiver.y - source.y;
  const horizontal = Math.hypot(dx, dy);
  const zs = source.z;
  const zr = receiver.z;
  if (!(horizontal > 0) || zs < 0 || zr < 0) return [];
  const c0 = profile.groundSpeed;
  const ratio = speedAt(profile, Math.max(zs, zr)) / c0;
  const lowest = Math.atan(Math.sqrt(Math.max(0, (ratio - 1) * (ratio + 1))));
  const hop = psi => 2 * c0 / g * Math.tan(psi);
  const unitX = dx / horizontal;
  const unitY = dy / horizontal;
  const rays = [];
  for (let bounces = 2; bounces <= maximumBounces; bounces += 1) {
    if ((bounces - 1) * hop(lowest) > horizontal) break;
    for (const turnedSource of [false, true]) {
      for (const turnedReceiver of [false, true]) {
        const total = psi => {
          const sinPsi = Math.sin(psi);
          const cosPsi = Math.cos(psi);
          const first = leg(profile, sinPsi, cosPsi, zs, turnedSource);
          const second = leg(profile, sinPsi, cosPsi, zr, turnedReceiver);
          if (!first || !second) return null;
          return { first, second, sinPsi, cosPsi, metres: first.metres + second.metres + (bounces - 1) * hop(psi) - horizontal };
        };
        let previousPsi = null;
        let previous = null;
        for (let step = 0; step <= BOUNCE_SCAN_STEPS; step += 1) {
          const psi = lowest + (HALF_PI - lowest) * (step / BOUNCE_SCAN_STEPS) ** 2 * (1 - 1e-9);
          const value = total(psi);
          if (value && previous && Number.isFinite(value.metres) && Number.isFinite(previous.metres) && (value.metres > 0) !== (previous.metres > 0)) {
            let low = previousPsi;
            let high = psi;
            for (let iteration = 0; iteration < BOUNCE_BISECTIONS; iteration += 1) {
              const middle = (low + high) / 2;
              const at = total(middle);
              if (!at || !Number.isFinite(at.metres)) break;
              if ((at.metres > 0) === (previous.metres > 0)) low = middle; else high = middle;
            }
            const root = total((low + high) / 2);
            if (root) rays.push(bounceRay(profile, source, receiver, root, bounces, horizontal, unitX, unitY, hop));
          }
          previousPsi = psi;
          previous = value;
        }
      }
    }
  }
  return rays.filter(Boolean);
}

function bounceRay(profile, source, receiver, { first, second, sinPsi, cosPsi }, bounces, horizontal, unitX, unitY, hop) {
  const c0 = profile.groundSpeed;
  const g = profile.gradient;
  const length = hop(Math.asin(sinPsi));
  const at = metres => ({ x: source.x + unitX * metres, y: source.y + unitY * metres, z: 0 });
  const firstContact = at(first.metres);
  const lastContact = at(horizontal - second.metres);
  const down = rayBetween(profile, source, firstContact);
  const hopRay = rayBetween(profile, { x: 0, y: 0, z: 0 }, { x: length, y: 0, z: 0 });
  const up = rayBetween(profile, lastContact, receiver);
  const xi = cosPsi / c0;
  const derivative = Math.abs(first.derivative + second.derivative - (bounces - 1) * 2 / (g * sinPsi * xi * xi));
  const cs = speedAt(profile, source.z);
  const area = horizontal * derivative * first.sine * second.sine / (xi * cs * cs);
  const metres = down.metres + (bounces - 1) * hopRay.metres + up.metres;
  if (!(Number.isFinite(area) && area > 0)) return null;
  return {
    seconds: down.seconds + (bounces - 1) * hopRay.seconds + up.seconds,
    metres,
    spreadMetres: Math.max(Math.sqrt(area), metres * 10 ** (-PROPAGATION.causticLimitDb / 20)),
    departure: down.departure,
    arrival: up.arrival,
    groundSine: sinPsi,
    groundPoint: firstContact,
    bounces
  };
}

function imageRay(profile, source, receiver) {
  const dx = receiver.x - source.x;
  const dy = receiver.y - source.y;
  const dz = receiver.z + source.z;
  const metres = Math.hypot(dx, dy, dz);
  const toGround = source.z / dz;
  return {
    seconds: metres / profile.groundSpeed,
    metres,
    spreadMetres: metres,
    departure: { x: dx / metres, y: dy / metres, z: -dz / metres },
    arrival: { x: dx / metres, y: dy / metres, z: dz / metres },
    groundSine: dz / metres,
    groundPoint: { x: source.x + dx * toGround, y: source.y + dy * toGround, z: 0 }
  };
}

/** Class B/C. */
export function shadowPath(profile, source, receiver) {
  const dx = receiver.x - source.x;
  const dy = receiver.y - source.y;
  const horizontal = Math.hypot(dx, dy);
  const fromSource = grazingRange(profile, source.z);
  const toReceiver = grazingRange(profile, receiver.z);
  const creepMetres = horizontal - fromSource - toReceiver;
  const unitX = dx / horizontal;
  const unitY = dy / horizontal;
  const level = { x: unitX, y: unitY, z: 0 };
  const touch = { x: source.x + unitX * fromSource, y: source.y + unitY * fromSource, z: 0 };
  const leave = { x: touch.x + unitX * creepMetres, y: touch.y + unitY * creepMetres, z: 0 };
  const down = fromSource > 0 ? rayBetween(profile, source, touch) : { seconds: 0, metres: 0, departure: level };
  const up = toReceiver > 0 ? rayBetween(profile, leave, receiver) : { seconds: 0, metres: 0, arrival: level };
  return {
    seconds: down.seconds + creepMetres / profile.groundSpeed + up.seconds,
    metres: down.metres + creepMetres + up.metres,
    spreadMetres: rayBetween(profile, source, receiver).spreadMetres,
    departure: down.departure,
    arrival: up.arrival,
    creepMetres
  };
}

export function inShadow(profile, source, receiver) {
  return Math.hypot(receiver.x - source.x, receiver.y - source.y) > grazingRange(profile, source.z) + grazingRange(profile, receiver.z);
}

function secondsBetween(profile, a, b) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const mean = Math.sqrt(speedAt(profile, a.z) * speedAt(profile, b.z));
  return distance / mean * asinhRatio(Math.abs(profile.gradient) * distance / (2 * mean));
}

export function travelSeconds(profile, source, receiver) {
  const horizontal = Math.hypot(receiver.x - source.x, receiver.y - source.y);
  const fromSource = grazingRange(profile, source.z);
  const toReceiver = grazingRange(profile, receiver.z);
  if (horizontal <= fromSource + toReceiver) return secondsBetween(profile, source, receiver);
  const along = (metres, z) => ({ x: source.x + (receiver.x - source.x) * metres / horizontal, y: source.y + (receiver.y - source.y) * metres / horizontal, z });
  return secondsBetween(profile, source, along(fromSource, 0)) + (horizontal - fromSource - toReceiver) / profile.groundSpeed
    + secondsBetween(profile, along(horizontal - toReceiver, 0), receiver);
}

export function firstArrival(profile, source, receiver) {
  return inShadow(profile, source, receiver) ? shadowPath(profile, source, receiver) : rayBetween(profile, source, receiver);
}

/** Class B: Airy-function creeping mode over rigid ground (Pierce, Acoustics, 1981, ch. 9; verify). */
export function creepingCoefficient(profile) {
  if (profile.gradient >= 0 || flat(profile)) return 0;
  const c0 = profile.groundSpeed;
  return Math.sqrt(3) / 2 * RIGID_CREEPING_ZERO * Math.cbrt(Math.PI / c0) * (-profile.gradient / c0) ** (2 / 3);
}

/** The linear fit extended far above the troposphere would slow a meteor's fronts to near zero. */
export function localProfile(profile, heightMetres) {
  const trueSpeed = profile.layered?.trueSpeed;
  if (!trueSpeed) return profile;
  const speed = trueSpeed(heightMetres);
  return Math.abs(speedAt(profile, heightMetres) - speed) <= VIEW.wavefront.localProfileTolerance * speed ? profile : { groundSpeed: speed, gradient: 0 };
}

/** Class C: extend the front's linear fit continuously through the source's actual atmospheric speed. */
export function frontProfile(profile, heightMetres) {
  if (!profile.layered || !(heightMetres > profile.layered.fitHeight)) return profile;
  return { ...profile, gradient: (profile.layered.trueSpeed(heightMetres) - profile.groundSpeed) / heightMetres };
}

export function wavefront(profile, source, seconds) {
  const cs = speedAt(profile, source.z);
  if (flat(profile)) return { centre: source, radiusMetres: cs * seconds };
  const g = profile.gradient;
  const sigma = Math.abs(g) * seconds;
  const scale = cs / Math.abs(g);
  const shift = 2 * Math.sinh(sigma / 2) ** 2 * scale;
  return { centre: { x: source.x, y: source.y, z: source.z + Math.sign(g) * shift }, radiusMetres: scale * Math.sinh(sigma) };
}
