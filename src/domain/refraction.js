import { speedOfSoundMetresPerSecond, temperatureAtHeightKelvin } from './air.js';
import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN } from './constants.js';

/**
 * Sound paths in air whose sound speed changes linearly with height, c(z) = c₀ + g·z. Coordinates
 * are metres (x east, y north, z up, ground at z = 0), times seconds, speeds m/s, g in 1/s.
 *
 * Class A for the given profile. With c linear in z the medium is the half-space model of
 * hyperbolic geometry, with lengths measured in travel time: rays are circular arcs centred on the
 * height where c would vanish, z* = −c₀/g, and the travel time between two points is
 * t = arcosh(1 + D²/(2 a₁ a₂)) / |g|, with D their distance and a = c/|g| (Červený 2000, as quoted
 * in arXiv 2003.11418). Wavefronts of a point source are spheres, and a ray tube's area follows
 * from the hyperbolic sphere, (a sinh σ)² per steradian with σ = |g|·t.
 *
 * Class B: the profile is the secant of c = sqrt(γ R T(z)) between the ground and
 * PROFILE_FIT_HEIGHT_METRES for T(z) = T₀ − Γz. That height keeps the shadow distance within 1.5 %
 * of the exact profile's for sources up to 12 km and Γ from 6.5 to 12 K/km; with the ISA gradient
 * the speed departs by at most 1.8 m/s up to 10 km.
 */

export const PROFILE_FIT_HEIGHT_METRES = 3000;
/** Below this gradient (1/s) the air is homogeneous and rays are straight. */
const FLAT_GRADIENT = 1e-12;
/** First zero of Ai′(−τ): the least-attenuated creeping mode over rigid ground. */
const RIGID_CREEPING_ZERO = 1.0187929716;
/** Greatest focusing gain of a reflected ray tube near a caustic, in decibels (class C). */
export const CAUSTIC_LIMIT_DB = 10;
const ROOT_ITERATIONS = 100;
/** Relative tolerance of the reflected ray's horizontal distance. */
const ROOT_TOLERANCE_METRES = 1e-11;
const BRANCH_SCAN_STEPS = 64;
const HALF_PI = Math.PI / 2;
/** Squared sines this close below zero are rounding at a turning point. */
const ROUNDING = 1e-12;

export const PATH_DIRECT = 0;
export const PATH_GROUND = 1;
export const PATH_SHADOW = 2;

/** The linear sound-speed profile of the scene's air: ground speed c₀ and gradient g. */
export function soundSpeedProfile(air) {
  const groundSpeed = speedOfSoundMetresPerSecond(air.temperatureCelsius);
  if (!air.refraction) return { groundSpeed, gradient: 0 };
  const topSpeed = Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, PROFILE_FIT_HEIGHT_METRES));
  return { groundSpeed, gradient: (topSpeed - groundSpeed) / PROFILE_FIT_HEIGHT_METRES };
}

export const speedAt = (profile, heightMetres) => profile.groundSpeed + profile.gradient * heightMetres;

const flat = profile => Math.abs(profile.gradient) < FLAT_GRADIENT;

/** asinh(x)/x, accurate near zero. */
function asinhRatio(x) {
  return x < 1e-4 ? 1 - x * x / 6 : Math.asinh(x) / x;
}

/** θ/sin θ for the arc length of a circular arc from its chord, accurate near zero. */
function arcRatio(half) {
  return half < 1e-4 ? 1 + half * half / 6 : half / Math.sin(half);
}

/**
 * The ray between two points: travel time, arc length, the spreading distance whose inverse is
 * the amplitude factor (D in homogeneous air), and unit propagation directions where it leaves `a`
 * and where it reaches `b`. It may pass below the ground; `inShadow` tells whether it does.
 */
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
  // Tangents in the vertical plane (horizontal, vertical), from the circle through both points
  // centred at z*; scaled by 2·horizontal·|g| so that they stay finite as g → 0.
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

/**
 * Horizontal distance from a height down to where a ray grazes the ground, in air whose speed
 * falls with height; Infinity otherwise. The direct ray from height z₁ to height z₂ stays above the
 * ground up to a horizontal distance of grazingRange(z₁) + grazingRange(z₂); beyond lies the
 * shadow. For small heights it is sqrt(2·c₀·z/|g|) (Fleagle 1949).
 */
export function grazingRange(profile, heightMetres) {
  if (profile.gradient >= 0 || flat(profile)) return Infinity;
  if (heightMetres <= 0) return 0;
  const c0 = profile.groundSpeed;
  const cz = speedAt(profile, heightMetres);
  const sine = Math.sqrt(-profile.gradient * heightMetres / c0 * (1 + cz / c0));
  return heightMetres * (cz + c0) / (c0 * sine);
}

/**
 * One leg of a reflected ray, from the ground up to a height, for a ray that meets the ground at
 * grazing angle ψ: horizontal distance and its derivative with respect to the ray parameter
 * ξ = cos ψ / c₀ (Snell's invariant cos θ / c). `turned` legs pass their highest point before
 * reaching the height, which only happens when the speed grows with height.
 */
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

/**
 * The ψ in [low, high] where `range(ψ)` reaches `target`, by Newton steps on the analytic slope that
 * fall back to bisection whenever a step leaves the bracket; the bracket ends lie on either side.
 */
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

/**
 * The ground-reflected ray between a source and a receiver, or null where none exists (in the
 * shadow, or beyond the reach of single reflections). Both legs share Snell's invariant, so the
 * ray is the one whose two legs from the ground point add up to the horizontal distance; with a
 * gradient that grows with height the higher leg may turn first. The ray tube gives the spreading,
 * A = ρ·|∂ρ/∂ξ|·sin θs·sin θr / (ξ·cs²), capped near caustics.
 */
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
  // Lowest grazing angle at which the higher end is reached before turning.
  const lowest = g > 0 && !flat(profile) ? Math.atan(Math.sqrt(Math.max(0, (ratio - 1) * (ratio + 1)))) : 0;
  const pair = (psi, turnedHigher) => {
    const sinPsi = Math.sin(psi);
    const cosPsi = Math.cos(psi);
    const first = leg(profile, sinPsi, cosPsi, zs, turnedHigher && zs >= zr);
    const second = leg(profile, sinPsi, cosPsi, zr, turnedHigher && zr > zs);
    return first && second ? { first, second, sinPsi, cosPsi } : null;
  };
  // Horizontal distance and its slope dρ/dψ = dρ/dξ · (−sin ψ / c₀).
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
  spreadMetres = Math.max(spreadMetres, metres * 10 ** (-CAUSTIC_LIMIT_DB / 20));
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

/** The reflected ray in homogeneous air: the straight path from the image source below the ground. */
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

/**
 * The path into the shadow (class B/C): the limiting ray grazes the ground, the sound creeps along
 * it for `creepMetres` at the ground speed, and leaves on the limiting ray to the receiver. Its
 * spreading is that of the ray the ground blocks, so it meets the direct ray at the shadow boundary.
 */
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

/** Travel time of the ray between two points alone, for views that need many of them. */
function secondsBetween(profile, a, b) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const mean = Math.sqrt(speedAt(profile, a.z) * speedAt(profile, b.z));
  return distance / mean * asinhRatio(Math.abs(profile.gradient) * distance / (2 * mean));
}

/** Travel time of the first sound from a point to a receiver, as `firstArrival` gives it. */
export function travelSeconds(profile, source, receiver) {
  const horizontal = Math.hypot(receiver.x - source.x, receiver.y - source.y);
  const fromSource = grazingRange(profile, source.z);
  const toReceiver = grazingRange(profile, receiver.z);
  if (horizontal <= fromSource + toReceiver) return secondsBetween(profile, source, receiver);
  const along = (metres, z) => ({ x: source.x + (receiver.x - source.x) * metres / horizontal, y: source.y + (receiver.y - source.y) * metres / horizontal, z });
  return secondsBetween(profile, source, along(fromSource, 0)) + (horizontal - fromSource - toReceiver) / profile.groundSpeed
    + secondsBetween(profile, along(horizontal - toReceiver, 0), receiver);
}

/** The first sound from a point to a receiver: the direct ray, or the creeping path in the shadow. */
export function firstArrival(profile, source, receiver) {
  return inShadow(profile, source, receiver) ? shadowPath(profile, source, receiver) : rayBetween(profile, source, receiver);
}

/**
 * Class B: attenuation of the least-attenuated creeping mode along the ground, in nepers per metre
 * per cube root of hertz: α(f) = (√3/2)·τ₁·(k/2)^(1/3)·(|g|/c₀)^(2/3) with k = 2πf/c₀ and τ₁ the
 * first zero of Ai′ (rigid ground). It follows from the Airy-function mode of a linear profile over
 * a reflecting plane, the same form as Fock's creeping waves on a curved surface of radius c₀/|g|
 * (Pierce, Acoustics, 1981, ch. 9; verify). Softer ground attenuates more.
 */
export function creepingCoefficient(profile) {
  if (profile.gradient >= 0 || flat(profile)) return 0;
  const c0 = profile.groundSpeed;
  return Math.sqrt(3) / 2 * RIGID_CREEPING_ZERO * Math.cbrt(Math.PI / c0) * (-profile.gradient / c0) ** (2 / 3);
}

/**
 * The wavefront of a point source after `seconds`: a sphere whose centre moves away from the
 * height where c would vanish, at a·cosh σ, with radius a·sinh σ, σ = |g|·t, a = c(zs)/|g|.
 */
export function wavefront(profile, source, seconds) {
  const cs = speedAt(profile, source.z);
  if (flat(profile)) return { centre: source, radiusMetres: cs * seconds };
  const g = profile.gradient;
  const sigma = Math.abs(g) * seconds;
  const scale = cs / Math.abs(g);
  const shift = 2 * Math.sinh(sigma / 2) ** 2 * scale;
  return { centre: { x: source.x, y: source.y, z: source.z + Math.sign(g) * shift }, radiusMetres: scale * Math.sinh(sigma) };
}
