import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN } from './constants.js';
import { airDensityKilogramsPerCubicMetre, pressureAtHeightPa, temperatureAtHeightKelvin } from './air.js';
import { WEAK_SHOCK, weakShockPulse } from './lightning.js';
import { createRandom, normalDeviate } from './random.js';

/**
 * A meteoroid entering the atmosphere as a line source (class B, ReVelle 1976, the theory Boomtect
 * uses for thunder). Drag deposits E₀ = ½·ρ·v²·C_D·π(d/2)² per metre of trail; the blast radius is
 * R₀ = √(E₀/p), about M·d; each piece of trail radiates an N-wave of period 2.81·R₀/c that lengthens
 * as x^¼ (`weakShockPulse`). Literature prefactors of R₀ differ by up to 3.5 (Silber et al. 2018
 * review); the theory holds while v ≫ c and the body barely slows, so the speed is kept constant
 * (class C) and the trail ends at a height. The trail is cut into pieces like a lightning channel;
 * their emission times follow the flight, so the Mach cone forms in their sum (class A).
 */

/** The share of the deposited energy each piece radiates as sound (class C, as lightning's default). */
export const METEOR_ACOUSTIC_EFFICIENCY = .01;
const PERIOD_COEFFICIENT = 2.81;
const LIMIT_RADII = 1e4;

const soundSpeedAt = (air, heightMetres) => Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, heightMetres));

/** The straight trail of a meteor: its start, unit direction of flight, speed, and length to its end height. */
export function meteorTrail(meteor) {
  const heading = meteor.headingDegrees * Math.PI / 180;
  const entry = meteor.entryDegrees * Math.PI / 180;
  const direction = { x: Math.cos(entry) * Math.sin(heading), y: Math.cos(entry) * Math.cos(heading), z: -Math.sin(entry) };
  const lengthMetres = Math.max(0, (meteor.startMetres.z - meteor.endHeightMetres) / Math.sin(entry));
  return { start: meteor.startMetres, direction, speed: meteor.speedKilometresPerSecond * 1000, lengthMetres };
}

/** The point sources of a meteor's trail (shaped as `flashSources`), with `flash` its index in a shower. */
export function meteorSources(meteor, air, flash = 0) {
  const { start, direction, speed, lengthMetres } = meteorTrail(meteor);
  const groundSpeed = soundSpeedAt(air, 0);
  const groundDensity = airDensityKilogramsPerCubicMetre(air.pressureKpa * 1000, air.temperatureCelsius);
  const area = Math.PI * (meteor.diameterMetres / 2) ** 2;
  const pieces = Math.max(1, Math.ceil(lengthMetres / meteor.segmentLengthMetres));
  const piece = lengthMetres / pieces;
  const sources = [];
  for (let index = 0; index < pieces; index += 1) {
    const along = (index + .5) * piece;
    const position = { x: start.x + direction.x * along, y: start.y + direction.y * along, z: start.z + direction.z * along };
    const pressurePa = pressureAtHeightPa(air, position.z);
    const density = pressurePa / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, position.z));
    const energy = .5 * density * speed * speed * meteor.dragCoefficient * area;
    const radius = Math.sqrt(energy / pressurePa);
    const localSpeed = soundSpeedAt(air, position.z);
    const sourcePeriodSeconds = PERIOD_COEFFICIENT * radius / localSpeed;
    const reference = weakShockPulse(radius, sourcePeriodSeconds, 0, LIMIT_RADII);
    const acousticEnergy = METEOR_ACOUSTIC_EFFICIENCY * energy * piece;
    sources.push({
      flash,
      positionMetres: position,
      direction,
      elementMetres: piece,
      // The body crosses the piece as it radiates: its emission lags by s/v along it, which the renderer
      // takes as a cosine of c₀/v off its directivity (c₀ the ground speed, the renderer's unit).
      flowCosine: groundSpeed / speed,
      emissionSeconds: meteor.startSeconds + along / speed,
      amplitudePaMetres: Math.sqrt(3 * groundDensity * groundSpeed * acousticEnergy / (4 * Math.PI * reference.durationSeconds)),
      pulse: 'n-wave',
      weakShock: { relaxationRadius: radius, sourcePeriodSeconds, limitRadii: LIMIT_RADII },
      durationSeconds: reference.durationSeconds,
      decay: 0,
      spanSeconds: weakShockPulse(radius, sourcePeriodSeconds, Infinity, LIMIT_RADII).durationSeconds,
      linearRadiusMetres: radius * WEAK_SHOCK.startRadii
    });
  }
  return sources;
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
  const steps = Math.max(2, Math.ceil(duration / .02));
  const step = duration / steps;
  const track = { seconds: [], x: [], y: [], z: [], step };
  for (let index = 0; index <= steps; index += 1) {
    const along = index * step * speed;
    track.seconds.push(meteor.startSeconds + index * step);
    track.x.push(start.x + direction.x * along); track.y.push(start.y + direction.y * along); track.z.push(start.z + direction.z * along);
  }
  return track;
}
