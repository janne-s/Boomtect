import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, METEOR, THUNDER, TNT_JOULES_PER_KILOGRAM } from './constants.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from './air.js';
import { stationaryArrivals } from './flight.js';
import { weakShockPulse } from './lightning.js';
import { createRandom, normalDeviate } from '../shared/domain/random.js';

/** Class B: ReVelle 1976 as restated by Silber et al. 2015 (eq. 4b); constant speed class C; impedance scaling class B. */

const START_RADII = THUNDER.weakShock.startRadii;
const START_OVERPRESSURE_RATIO = 2 * GAMMA_AIR / (GAMMA_AIR + 1) * .4503 / ((1 + 4.803 * START_RADII ** 2) ** (3 / 8) - 1);
const TRACK_STEP_SECONDS = .02;

const soundSpeedAt = (air, heightMetres) => Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, heightMetres));
const densityAt = (air, heightMetres) => pressureAtHeightPa(air, heightMetres) / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, heightMetres));

export function meteorTrail(meteor) {
  const heading = meteor.headingDegrees * Math.PI / 180;
  const entry = meteor.entryDegrees * Math.PI / 180;
  const direction = { x: Math.cos(entry) * Math.sin(heading), y: Math.cos(entry) * Math.cos(heading), z: -Math.sin(entry) };
  const lengthMetres = Math.max(0, (meteor.startMetres.z - meteor.endHeightMetres) / Math.sin(entry));
  return { start: meteor.startMetres, direction, speed: meteor.speedKilometresPerSecond * 1000, lengthMetres };
}

export function meteorBlast(meteor, air, heightMetres) {
  const pressurePa = pressureAtHeightPa(air, heightMetres);
  const density = densityAt(air, heightMetres);
  const speed = meteor.speedKilometresPerSecond * 1000;
  const energy = .5 * density * speed * speed * meteor.dragCoefficient * Math.PI * (meteor.diameterMetres / 2) ** 2;
  const radius = Math.sqrt(energy / pressurePa);
  return { radiusMetres: radius, sourcePeriodSeconds: METEOR.periodCoefficient * radius / soundSpeedAt(air, heightMetres), pressurePa };
}

export function meteorBoom(meteor, air, heightMetres, metres, receiverPressurePa) {
  const { radiusMetres, sourcePeriodSeconds, pressurePa } = meteorBlast(meteor, air, heightMetres);
  const x = Math.max(START_RADII, metres / radiusMetres);
  const ratio = START_OVERPRESSURE_RATIO * (Math.min(x, METEOR.limitRadii) / START_RADII) ** -.75 * (Math.max(x, METEOR.limitRadii) / METEOR.limitRadii) ** -.5;
  return {
    overpressurePa: ratio * Math.sqrt(pressurePa * receiverPressurePa),
    durationSeconds: weakShockPulse(radiusMetres, sourcePeriodSeconds, metres, METEOR.limitRadii).durationSeconds
  };
}

export function meteorKineticEnergy(meteor) {
  const mass = meteor.densityKilogramsPerCubicMetre * Math.PI / 6 * meteor.diameterMetres ** 3;
  return .5 * mass * (meteor.speedKilometresPerSecond * 1000) ** 2;
}

/** Energy shares class C; breakup strength class B (Popova et al. 2011). */
export function meteorBursts(meteor, air) {
  const { start, direction, speed, lengthMetres } = meteorTrail(meteor);
  const energy = meteorKineticEnergy(meteor);
  const heightAt = along => start.z + direction.z * along;
  const ramPressure = along => densityAt(air, heightAt(along)) * speed * speed;
  const random = createRandom(meteor.seed);
  const places = [];
  for (let generation = 0; generation < meteor.breakupCount; generation += 1) {
    const fragments = 2 ** generation;
    for (let fragment = 0; fragment < fragments; fragment += 1) {
      const target = meteor.strengthMegapascals * 1e6 * METEOR.breakupPressureRatio ** generation
        * Math.exp(METEOR.breakupPressureSpread * normalDeviate(random));
      if (ramPressure(0) >= target || ramPressure(lengthMetres) < target) continue;
      let low = 0;
      let high = lengthMetres;
      for (let step = 0; step < 50; step += 1) {
        const middle = (low + high) / 2;
        if (ramPressure(middle) < target) low = middle; else high = middle;
      }
      places.push({ along: high, energyJoules: meteor.breakupShare * energy / fragments });
    }
  }
  if (meteor.burstShare > 0) places.push({ along: lengthMetres, energyJoules: meteor.burstShare * energy });
  let left = energy;
  const budgeted = places.sort((a, b) => a.along - b.along).map(place => {
    const energyJoules = Math.min(place.energyJoules, left);
    left -= energyJoules;
    return { along: place.along, energyJoules };
  });
  return budgeted.filter(place => place.energyJoules > 0).map(({ along, energyJoules }) => ({
    positionMetres: { x: start.x + direction.x * along, y: start.y + direction.y * along, z: heightAt(along) },
    emissionSeconds: meteor.startSeconds + along / speed,
    chargeKilograms: energyJoules / TNT_JOULES_PER_KILOGRAM
  }));
}

export function meteorBooms(track, meteor, receiver, profile, air) {
  const receiverPressurePa = pressureAtHeightPa(air, Math.max(0, receiver.z));
  return stationaryArrivals(track, receiver, profile).map(arrival => ({
    ...arrival, focus: 1, ...meteorBoom(meteor, air, arrival.point.z, arrival.ray.metres, receiverPressurePa)
  }));
}

/** Class C. */
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
      seed: (shower.seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0,
      startSeconds: shower.startSeconds + random() * shower.durationSeconds,
      startMetres: { x: shower.startMetres.x + radius * Math.cos(angle), y: shower.startMetres.y + radius * Math.sin(angle), z: shower.startMetres.z },
      diameterMetres: shower.diameterMetres * Math.exp(sigma * normalDeviate(random) - sigma * sigma / 2)
    };
  });
}

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
