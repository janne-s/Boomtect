import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN } from './constants.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from './air.js';
import { stationaryArrivals } from './flight.js';
import { WEAK_SHOCK, weakShockPulse } from './lightning.js';
import { createRandom, normalDeviate } from './random.js';

/**
 * A meteoroid entering the atmosphere as a line source (class B, ReVelle 1976). Drag deposits
 * E₀ = ½·ρ·v²·C_D·π(d/2)² per metre of trail; the blast radius is R₀ = √(E₀/p), about M·d. The
 * theory holds while v ≫ c and the body barely slows, so the speed is kept constant (class C) and
 * the trail ends at a height.
 *
 * Its boom leaves the trail where the arrival at the receiver is stationary, where the ray leaves
 * on the Mach cone (class A, as a flight's, `stationaryArrivals`). The trail's cylindrical blast
 * wave already integrates the line, so the boom is one N-wave from there (class B, ReVelle 1976 as
 * restated by Silber et al. 2015): at x = r/R₀ = 10, where the weak-shock regime begins,
 *   Δp/p = 2γ/(γ+1) · 0.4503 / ((1 + 4.803·x^(8/3))^(3/8) − 1),
 * then Δp ∝ x^(−3/4) as a weak cylindrical shock up to LIMIT_RADII and x^(−1/2) as a linear wave
 * beyond; its period τ₀ = 2.81·R₀/c lengthens as x^¼ (`weakShockPulse`). From the air at the
 * trail to the air at the receiver the overpressure scales with √(p_trail·p_receiver), as
 * Carlson's (class B for the impedance law, temperature neglected).
 */

const PERIOD_COEFFICIENT = 2.81;
const LIMIT_RADII = 1e4;
const START_RADII = WEAK_SHOCK.startRadii;
const START_OVERPRESSURE_RATIO = 2 * GAMMA_AIR / (GAMMA_AIR + 1) * .4503 / ((1 + 4.803 * START_RADII ** (8 / 3)) ** (3 / 8) - 1);
/** Seconds between the points of a meteor's track. */
const TRACK_STEP_SECONDS = .02;

const soundSpeedAt = (air, heightMetres) => Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, heightMetres));

/** The straight trail of a meteor: its start, unit direction of flight, speed, and length to its end height. */
export function meteorTrail(meteor) {
  const heading = meteor.headingDegrees * Math.PI / 180;
  const entry = meteor.entryDegrees * Math.PI / 180;
  const direction = { x: Math.cos(entry) * Math.sin(heading), y: Math.cos(entry) * Math.cos(heading), z: -Math.sin(entry) };
  const lengthMetres = Math.max(0, (meteor.startMetres.z - meteor.endHeightMetres) / Math.sin(entry));
  return { start: meteor.startMetres, direction, speed: meteor.speedKilometresPerSecond * 1000, lengthMetres };
}

/** The blast radius R₀, m, and source period τ₀, s, of a meteor's trail at a height. */
export function meteorBlast(meteor, air, heightMetres) {
  const pressurePa = pressureAtHeightPa(air, heightMetres);
  const density = pressurePa / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, heightMetres));
  const speed = meteor.speedKilometresPerSecond * 1000;
  const energy = .5 * density * speed * speed * meteor.dragCoefficient * Math.PI * (meteor.diameterMetres / 2) ** 2;
  const radius = Math.sqrt(energy / pressurePa);
  return { radiusMetres: radius, sourcePeriodSeconds: PERIOD_COEFFICIENT * radius / soundSpeedAt(air, heightMetres), pressurePa };
}

/** A meteor's boom `metres` along the ray from a point of its trail at a height: overpressure, Pa, and N-wave duration, s. */
export function meteorBoom(meteor, air, heightMetres, metres, receiverPressurePa) {
  const { radiusMetres, sourcePeriodSeconds, pressurePa } = meteorBlast(meteor, air, heightMetres);
  const x = Math.max(START_RADII, metres / radiusMetres);
  const ratio = START_OVERPRESSURE_RATIO * (Math.min(x, LIMIT_RADII) / START_RADII) ** -.75 * (Math.max(x, LIMIT_RADII) / LIMIT_RADII) ** -.5;
  return {
    overpressurePa: ratio * Math.sqrt(pressurePa * receiverPressurePa),
    durationSeconds: weakShockPulse(radiusMetres, sourcePeriodSeconds, metres, LIMIT_RADII).durationSeconds
  };
}

/** The booms of a meteor's track at a receiver, in the frame of the track (heights above the datum). */
export function meteorBooms(track, meteor, receiver, profile, air) {
  const receiverPressurePa = pressureAtHeightPa(air, Math.max(0, receiver.z));
  return stationaryArrivals(track, receiver, profile).map(arrival => ({
    ...arrival, focus: 1, ...meteorBoom(meteor, air, arrival.point.z, arrival.ray.metres, receiverPressurePa)
  }));
}

/**
 * The meteors of a shower: parallel trails from one radiant, entering over a disc around the start
 * at heights spread over its depth, at times over its duration, with diameters spread lognormally
 * about the mean. Deterministic from the seed (class C).
 */
export function showerMembers(shower) {
  if (shower.kind !== 'shower') return [shower];
  const random = createRandom(shower.seed);
  return Array.from({ length: shower.meteorCount }, (_, index) => {
    const radius = shower.radiusMetres * Math.sqrt(random());
    const angle = 2 * Math.PI * random();
    const sigma = shower.diameterSpread;
    return {
      ...shower,
      id: `${shower.id}:${index}`,
      startSeconds: shower.startSeconds + random() * shower.durationSeconds,
      startMetres: { x: shower.startMetres.x + radius * Math.cos(angle), y: shower.startMetres.y + radius * Math.sin(angle), z: shower.startMetres.z },
      diameterMetres: shower.diameterMetres * Math.exp(sigma * normalDeviate(random) - sigma * sigma / 2)
    };
  });
}

/** A meteor's trail as a track for views: times and positions every `step` seconds. */
export function meteorTrack(meteor) {
  const { start, direction, speed, lengthMetres } = meteorTrail(meteor);
  const duration = lengthMetres / speed;
  const steps = Math.max(2, Math.ceil(duration / TRACK_STEP_SECONDS));
  const step = duration / steps;
  const track = { seconds: [], x: [], y: [], z: [], step };
  for (let index = 0; index <= steps; index += 1) {
    const along = index * step * speed;
    track.seconds.push(meteor.startSeconds + index * step);
    track.x.push(start.x + direction.x * along); track.y.push(start.y + direction.y * along); track.z.push(start.z + direction.z * along);
  }
  return track;
}
