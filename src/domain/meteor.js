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
const TNT_JOULES_PER_KILOGRAM = 4.184e6;
/**
 * The ram pressure ρv² grows by this factor from one breakup to the next: the fragments are smaller
 * and stronger (class C; Popova et al. 2011 find several breakups per fireball at rising pressures).
 */
const BREAKUP_PRESSURE_RATIO = 2;

const soundSpeedAt = (air, heightMetres) => Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, heightMetres));
const densityAt = (air, heightMetres) => pressureAtHeightPa(air, heightMetres) / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, heightMetres));

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
  const density = densityAt(air, heightMetres);
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

/** A meteoroid's kinetic energy, J, as a sphere of its diameter and density. */
export function meteorKineticEnergy(meteor) {
  const mass = meteor.densityKilogramsPerCubicMetre * Math.PI / 6 * meteor.diameterMetres ** 3;
  return .5 * mass * (meteor.speedKilometresPerSecond * 1000) ** 2;
}

/**
 * Where a meteoroid breaks up and where it bursts, as blasts of a TNT equivalent (class C for the
 * shares of its kinetic energy they release). The first breakup comes where the ram pressure ρv²
 * reaches its strength (class B, Popova et al. 2011: 0.1–1 MPa for most fireballs, 1–5 MPa at
 * Chelyabinsk), each next at BREAKUP_PRESSURE_RATIO times the last, while above the end of the
 * trail; the terminal burst is where the trail ends.
 */
export function meteorBursts(meteor, air) {
  const { start, direction, speed, lengthMetres } = meteorTrail(meteor);
  const energy = meteorKineticEnergy(meteor);
  const heightAt = along => start.z + direction.z * along;
  const ramPressure = along => densityAt(air, heightAt(along)) * speed * speed;
  const places = [];
  for (let breakup = 0; breakup < meteor.breakupCount; breakup += 1) {
    const target = meteor.strengthMegapascals * 1e6 * BREAKUP_PRESSURE_RATIO ** breakup;
    if (ramPressure(0) >= target) continue;
    if (ramPressure(lengthMetres) < target) break;
    // The air thickens downward along the trail, so the crossing is found by bisection.
    let low = 0;
    let high = lengthMetres;
    for (let step = 0; step < 50; step += 1) {
      const middle = (low + high) / 2;
      if (ramPressure(middle) < target) low = middle; else high = middle;
    }
    places.push({ along: high, energyJoules: meteor.breakupShare * energy });
  }
  if (meteor.burstShare > 0) places.push({ along: lengthMetres, energyJoules: meteor.burstShare * energy });
  return places.filter(place => place.energyJoules > 0).map(({ along, energyJoules }) => ({
    positionMetres: { x: start.x + direction.x * along, y: start.y + direction.y * along, z: heightAt(along) },
    emissionSeconds: meteor.startSeconds + along / speed,
    chargeKilograms: energyJoules / TNT_JOULES_PER_KILOGRAM
  }));
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
