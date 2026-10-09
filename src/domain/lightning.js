import { airDensityKilogramsPerCubicMetre, pressureAtHeightPa, speedOfSoundMetresPerSecond } from './air.js';
import { MAXIMUM_SEGMENTS_PER_EMITTER } from './constants.js';
import { nWaveDurationForPeak } from './pulses.js';
import { createRandom, normalDeviate } from './random.js';
import { add, deflected, distance, length, scaled, subtract, unit } from './vector.js';

export const FLASH_TYPES = Object.freeze(['cloud-to-ground', 'intra-cloud']);

/** Class C: propagation from a channel is treated as linear beyond this many relaxation radii. */
const LINEAR_RELAXATION_RADII = 10;
/** Class C: branches leave the main channel between these shares of its length. */
const BRANCH_JUNCTION_RANGE = Object.freeze([.15, .95]);
/** Class C: ground-flash branches descend at this angle from straight down, in degrees. */
const GROUND_BRANCH_ANGLE_DEGREES = Object.freeze([20, 60]);
/** Class C: cloud-flash branches stay within this elevation of the horizontal, in degrees. */
const CLOUD_BRANCH_ELEVATION_DEGREES = 20;
/** Class C: a branch reaches between this share and all of its nominal length. */
const BRANCH_LENGTH_MINIMUM_SHARE = .3;
/** A branch that comes this close to the ground ends there. */
const BRANCH_GROUND_CLEARANCE_METRES = 1;

const toRadians = degrees => degrees * Math.PI / 180;

/**
 * Class C: a deterministic tortuous path. Each step leaves the direction toward the end by a
 * half-normal angle with the given mean and a uniform azimuth, so the path wanders but reaches
 * its end. A path that would go below the ground is reflected above it, or ends when
 * `endAtGround` is set.
 */
export function tortuousPath(random, start, end, segmentLengthMetres, tortuosityDegrees, { endAtGround = false, budget = MAXIMUM_SEGMENTS_PER_EMITTER } = {}) {
  const total = distance(start, end);
  if (tortuosityDegrees === 0) {
    const count = Math.max(1, Math.ceil(total / segmentLengthMetres));
    if (count > budget) throw new RangeError('The lightning needs more segments than the supported limit.');
    return Array.from({ length: count + 1 }, (_, index) => add(start, scaled(subtract(end, start), index / count)));
  }
  const sigma = toRadians(tortuosityDegrees) * Math.sqrt(Math.PI / 2);
  const points = [{ ...start }];
  let position = { ...start };
  while (points.length <= budget) {
    if (distance(end, position) <= segmentLengthMetres) {
      points.push({ ...end });
      return points;
    }
    const direction = deflected(unit(subtract(end, position)), Math.abs(normalDeviate(random)) * sigma, 2 * Math.PI * random());
    position = add(position, scaled(direction, segmentLengthMetres));
    if (position.z < BRANCH_GROUND_CLEARANCE_METRES && endAtGround) {
      points.push({ ...position, z: Math.max(0, position.z) });
      return points;
    }
    if (position.z < 0) position.z = -position.z;
    points.push({ ...position });
  }
  throw new RangeError('The lightning needs more segments than the supported limit.');
}

/** Segments between consecutive points, with arc length from the path start to each centre. */
export function segmentsFromPoints(points) {
  const segments = [];
  let arcMetres = 0;
  for (let index = 1; index < points.length; index += 1) {
    const delta = subtract(points[index], points[index - 1]);
    const segmentLength = length(delta);
    if (!(segmentLength > 0)) continue;
    segments.push({
      centreMetres: add(points[index - 1], scaled(delta, .5)),
      direction: scaled(delta, 1 / segmentLength),
      lengthMetres: segmentLength,
      arcMetres: arcMetres + segmentLength / 2
    });
    arcMetres += segmentLength;
  }
  return segments;
}

/** The point at a given arc length along a polyline. */
function pointAtArc(points, arcMetres) {
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const step = distance(points[index], points[index - 1]);
    if (travelled + step >= arcMetres) return add(points[index - 1], scaled(subtract(points[index], points[index - 1]), (arcMetres - travelled) / step));
    travelled += step;
  }
  return { ...points.at(-1) };
}

const pathLength = points => points.slice(1).reduce((sum, point, index) => sum + distance(point, points[index]), 0);

/**
 * One flash as channels in space and strokes in time. The main channel runs from base to top;
 * branches leave it at seeded junctions. A ground flash's branches descend toward the ground, a
 * cloud flash's spread near the horizontal. Every later stroke follows the main channel only.
 * Segment energies vary by a mean-preserving lognormal factor (class C).
 */
export function lightningFlash(spec) {
  const random = createRandom(spec.seed);
  const budget = { remaining: spec.segmentBudget ?? MAXIMUM_SEGMENTS_PER_EMITTER };
  const walk = (start, end, options = {}) => {
    const points = tortuousPath(random, start, end, spec.segmentLengthMetres, spec.tortuosityDegrees, { ...options, budget: budget.remaining });
    budget.remaining -= points.length - 1;
    return points;
  };
  const mainPoints = walk(spec.baseMetres, spec.topMetres);
  const mainLength = pathLength(mainPoints);
  const channels = [{ points: mainPoints, main: true, energyScale: 1, emissionOffsetMetres: 0 }];
  const ground = spec.type === 'cloud-to-ground';
  for (let branch = 0; branch < spec.branchCount; branch += 1) {
    const junctionArc = mainLength * (BRANCH_JUNCTION_RANGE[0] + random() * (BRANCH_JUNCTION_RANGE[1] - BRANCH_JUNCTION_RANGE[0]));
    const junction = pointAtArc(mainPoints, junctionArc);
    const nominal = spec.branchLengthRatio * mainLength * (BRANCH_LENGTH_MINIMUM_SHARE + random() * (1 - BRANCH_LENGTH_MINIMUM_SHARE));
    let direction;
    if (ground) {
      const [low, high] = GROUND_BRANCH_ANGLE_DEGREES;
      direction = deflected({ x: 0, y: 0, z: -1 }, toRadians(low + random() * (high - low)), 2 * Math.PI * random());
    } else {
      const azimuth = 2 * Math.PI * random();
      const elevation = toRadians((2 * random() - 1) * CLOUD_BRANCH_ELEVATION_DEGREES);
      direction = { x: Math.cos(elevation) * Math.cos(azimuth), y: Math.cos(elevation) * Math.sin(azimuth), z: Math.sin(elevation) };
    }
    const reach = ground && direction.z < 0 ? Math.min(nominal, (junction.z - BRANCH_GROUND_CLEARANCE_METRES) / -direction.z) : nominal;
    if (!(reach > spec.segmentLengthMetres)) continue;
    const end = add(junction, scaled(direction, reach));
    channels.push({ points: walk(junction, end, { endAtGround: true }), main: false, energyScale: spec.branchEnergyRatio, emissionOffsetMetres: junctionArc });
  }
  for (const channel of channels) {
    channel.segments = segmentsFromPoints(channel.points);
    channel.energyVariation = Float64Array.from(channel.segments, () => Math.exp(spec.energyVariation * normalDeviate(random) - spec.energyVariation ** 2 / 2));
  }
  return {
    type: spec.type,
    startSeconds: spec.startSeconds,
    channelSpeedMetresPerSecond: spec.channelSpeedMetresPerSecond,
    energyJoulesPerMetre: spec.energyJoulesPerMetre,
    strokes: spec.strokes,
    channels
  };
}

/** Strokes of a single flash: equal intervals, later strokes at a fixed share of the first's energy. */
export function regularStrokes({ strokeCount, strokeIntervalSeconds, subsequentStrokeEnergyRatio }) {
  return Array.from({ length: strokeCount }, (_, index) => ({
    offsetSeconds: index * strokeIntervalSeconds,
    energyScale: index === 0 ? 1 : subsequentStrokeEnergyRatio
  }));
}

/**
 * Class B: Few's relaxation radius R₀ = sqrt(E_l / (π·p)) for an energy per unit length E_l
 * released into air at ambient pressure p.
 */
export const relaxationRadiusMetres = (energyJoulesPerMetre, pressurePa) => Math.sqrt(energyJoulesPerMetre / (Math.PI * pressurePa));

/**
 * Point sources of flashes. Each segment radiates an N-wave whose spectral peak is κ·c/R₀ at the
 * local ambient pressure (class B, Few). Its amplitude carries the acoustic share η of the
 * segment's energy as an isotropic far-field pulse (class C): P·1 m = sqrt(3ρc·η·E·ℓ / (4π·T)).
 * The segment radiates with the directivity of its straight element ℓs (class C).
 */
export function flashSources(flashes, physics, air, sources = []) {
  const speed = speedOfSoundMetresPerSecond(air.temperatureCelsius);
  const groundPressurePa = air.pressureKpa * 1000;
  const density = airDensityKilogramsPerCubicMetre(groundPressurePa, air.temperatureCelsius);
  flashes.forEach((flash, flashIndex) => {
    flash.strokes.forEach((stroke, strokeIndex) => {
      for (const channel of flash.channels) {
        if (!channel.main && strokeIndex > 0) continue;
        channel.segments.forEach((segment, segmentIndex) => {
          const energy = flash.energyJoulesPerMetre * stroke.energyScale * channel.energyScale * channel.energyVariation[segmentIndex];
          const pressurePa = pressureAtHeightPa(groundPressurePa, air.temperatureCelsius, segment.centreMetres.z);
          const radius = relaxationRadiusMetres(energy, pressurePa);
          const durationSeconds = nWaveDurationForPeak(physics.frequencyCoefficient * speed / radius);
          const acousticEnergy = physics.acousticEfficiency * energy * segment.lengthMetres;
          sources.push({
            flash: flashIndex,
            positionMetres: segment.centreMetres,
            direction: segment.direction,
            elementMetres: Math.min(physics.straightLengthMetres, segment.lengthMetres),
            emissionSeconds: flash.startSeconds + stroke.offsetSeconds + (channel.emissionOffsetMetres + segment.arcMetres) / flash.channelSpeedMetresPerSecond,
            amplitudePaMetres: Math.sqrt(3 * density * speed * acousticEnergy / (4 * Math.PI * durationSeconds)),
            pulse: 'n-wave',
            durationSeconds,
            decay: 0,
            spanSeconds: durationSeconds,
            linearRadiusMetres: radius * LINEAR_RELAXATION_RADII
          });
        });
      }
    });
  });
  return sources;
}

/** The flash of a single lightning emitter. */
export function lightningEmitterFlashes(emitter) {
  return [lightningFlash({ ...emitter, type: emitter.flashType, strokes: regularStrokes(emitter) })];
}
