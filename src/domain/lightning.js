import { airDensityKilogramsPerCubicMetre, pressureAtHeightPa, speedOfSoundMetresPerSecond } from './air.js';
import { MAXIMUM_SEGMENTS_PER_EMITTER } from './constants.js';
import { nWaveDurationForPeak } from './pulses.js';
import { createRandom, normalDeviate } from './random.js';
import { add, deflected, distance, length, scaled, subtract, unit } from './vector.js';

export const FLASH_TYPES = Object.freeze(['cloud-to-ground', 'intra-cloud']);

/**
 * Class B: ReVelle's cylindrical weak-shock theory (ReVelle 1974, 1976; used for thunder and
 * meteors). The fundamental period at x = r/R₀ = 10 is τ₀ = k·R₀/c with k ≈ 2.81, and in the weakly
 * nonlinear regime it grows as τ(x) = 0.562·τ₀·x^(1/4) while the overpressure falls as x^(−3/4),
 * that is x^(−1/4) faster than linear cylindrical spreading.
 */
export const WEAK_SHOCK = Object.freeze({ startRadii: 10, periodGrowth: .562, periodExponent: .25, extraDecayExponent: -.25 });

/** Class C: branches leave their parent between these shares of its length. */
const BRANCH_JUNCTION_RANGE = Object.freeze([.1, .95]);
/** Class C: ground-flash branches descend at this angle from straight down, in degrees. */
const GROUND_BRANCH_ANGLE_DEGREES = Object.freeze([15, 65]);
/** Class C: a sub-branch leaves its parent's direction by this angle, in degrees. */
const SUB_BRANCH_ANGLE_DEGREES = Object.freeze([20, 60]);
/** Class C: cloud-flash branches stay within this elevation of the horizontal, in degrees. */
const CLOUD_BRANCH_ELEVATION_DEGREES = 20;
/**
 * Class C: a ground flash's in-cloud channels. Mapped ground flashes show long, near-horizontal
 * channels inside the cloud (VHF lightning mapping; no typical length verified yet). Two leave the
 * top in roughly opposite directions, within this elevation, each reaching this share of the
 * nominal length or more.
 */
const IN_CLOUD_CHANNELS = 2;
const IN_CLOUD_ELEVATION_DEGREES = 10;
const IN_CLOUD_SPREAD_DEGREES = 50;
const IN_CLOUD_LENGTH_SHARE = Object.freeze([.6, 1]);
/** Class C: a branch reaches between this share and all of its nominal length. */
const BRANCH_LENGTH_MINIMUM_SHARE = .3;
/** Class C: each branching level has this share of the previous level's count and length. */
const SUB_BRANCH_COUNT_SHARE = .5;
const SUB_BRANCH_LENGTH_SHARE = .45;
/** Class C: a new ground termination leaves the channel between these shares of its height. */
const TERMINATION_JUNCTION_RANGE = Object.freeze([.2, .7]);
/** Class C: a new ground point lies this far from the junction per metre of junction height. */
const TERMINATION_REACH_RANGE = Object.freeze([.2, .8]);
/** Segments a tortuous walk may need per metre of straight reach, as a share of the step. */
const BUDGET_MARGIN = 2;
/** Rounding slack when dividing a straight path into steps. */
const STEP_TOLERANCE = 1e-9;
/** A branch that comes this close to the ground ends there. */
const GROUND_CLEARANCE_METRES = 1;

const toRadians = degrees => degrees * Math.PI / 180;
const FLAT_GROUND = () => 0;
const uniform = (random, [low, high]) => low + random() * (high - low);

/**
 * Class C: a deterministic tortuous path. Each step leaves the direction toward the end by a
 * half-normal angle with the given mean and a uniform azimuth, so the path wanders but reaches
 * its end. A path that would go below the ground (`groundAt(x, y)`, the plane z = 0 by default) is
 * reflected above it, or ends when `endAtGround` is set; a target below the ground is lifted onto it.
 */
export function tortuousPath(random, start, target, stepMetres, tortuosityDegrees, { endAtGround = false, budget = MAXIMUM_SEGMENTS_PER_EMITTER, groundAt = FLAT_GROUND } = {}) {
  // A target inside rising ground could never be reached by a walk kept above it; it moves up onto the ground.
  const groundAtTarget = groundAt(target.x, target.y);
  const end = target.z < groundAtTarget ? { ...target, z: groundAtTarget } : target;
  const total = distance(start, end);
  if (tortuosityDegrees === 0) {
    const count = Math.max(1, Math.ceil(total / stepMetres - STEP_TOLERANCE));
    if (count > budget) throw new RangeError(`A lightning channel needs more than ${budget} segments. Lengthen the segments or shorten the channel.`);
    return Array.from({ length: count + 1 }, (_, index) => add(start, scaled(subtract(end, start), index / count)));
  }
  const sigma = toRadians(tortuosityDegrees) * Math.sqrt(Math.PI / 2);
  const points = [{ ...start }];
  let position = { ...start };
  while (points.length <= budget) {
    if (distance(end, position) <= stepMetres) {
      points.push({ ...end });
      return points;
    }
    const direction = deflected(unit(subtract(end, position)), Math.abs(normalDeviate(random)) * sigma, 2 * Math.PI * random());
    position = add(position, scaled(direction, stepMetres));
    const ground = groundAt(position.x, position.y);
    if (position.z < ground + GROUND_CLEARANCE_METRES && endAtGround) {
      points.push({ ...position, z: Math.max(ground, position.z) });
      return points;
    }
    if (position.z < ground) position.z = 2 * ground - position.z;
    points.push({ ...position });
  }
  throw new RangeError(`A lightning channel needs more than ${budget} segments. Lengthen the segments or shorten the channel.`);
}

/**
 * Class C: a two-scale channel. A coarse walk with long steps and large deflections sets the
 * zigzag; a fine walk between its corners adds the small-scale tortuosity.
 */
function channelPath(random, start, end, spec, budget, options = {}) {
  const corners = tortuousPath(random, start, end, spec.macroStepMetres, spec.macroTortuosityDegrees, { ...options, groundAt: spec.groundAt });
  const points = [corners[0]];
  for (let index = 1; index < corners.length; index += 1) {
    const piece = tortuousPath(random, corners[index - 1], corners[index], spec.segmentLengthMetres, spec.tortuosityDegrees, { budget: budget.remaining, groundAt: spec.groundAt });
    budget.remaining -= piece.length - 1;
    points.push(...piece.slice(1));
  }
  return points;
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

const pathLength = points => points.slice(1).reduce((sum, point, index) => sum + distance(point, points[index]), 0);

/** The point and local direction at a given arc length along a polyline. */
function pointAtArc(points, arcMetres) {
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const step = distance(points[index], points[index - 1]);
    if (travelled + step >= arcMetres) {
      const delta = subtract(points[index], points[index - 1]);
      return { point: add(points[index - 1], scaled(delta, (arcMetres - travelled) / step)), direction: unit(delta) };
    }
    travelled += step;
  }
  return { point: { ...points.at(-1) }, direction: unit(subtract(points.at(-1), points.at(-2))) };
}

/**
 * Recursive branches of a channel. Ground-flash branches fan downward like stepped-leader
 * branches; cloud-flash branches spread near the horizontal. Each level has fewer, shorter, and
 * weaker branches than the one before.
 */
function growBranches(random, spec, budget, parent, level, channels) {
  if (level > spec.branchDepth) return;
  const count = Math.round(spec.branchCount * SUB_BRANCH_COUNT_SHARE ** (level - 1));
  const parentLength = pathLength(parent.points);
  const ground = spec.type === 'cloud-to-ground';
  for (let branch = 0; branch < count; branch += 1) {
    const junctionArc = parentLength * uniform(random, BRANCH_JUNCTION_RANGE);
    const { point: junction, direction: parentDirection } = pointAtArc(parent.points, junctionArc);
    const nominal = spec.branchLengthRatio * SUB_BRANCH_LENGTH_SHARE ** (level - 1) * parent.mainLength * uniform(random, [BRANCH_LENGTH_MINIMUM_SHARE, 1]);
    let direction;
    if (level > 1) direction = deflected(parentDirection, toRadians(uniform(random, SUB_BRANCH_ANGLE_DEGREES)), 2 * Math.PI * random());
    else if (ground) direction = deflected({ x: 0, y: 0, z: -1 }, toRadians(uniform(random, GROUND_BRANCH_ANGLE_DEGREES)), 2 * Math.PI * random());
    else {
      const azimuth = 2 * Math.PI * random();
      const elevation = toRadians((2 * random() - 1) * CLOUD_BRANCH_ELEVATION_DEGREES);
      direction = { x: Math.cos(elevation) * Math.cos(azimuth), y: Math.cos(elevation) * Math.sin(azimuth), z: Math.sin(elevation) };
    }
    const reach = direction.z < 0 ? Math.min(nominal, (junction.z - spec.groundAt(junction.x, junction.y) - GROUND_CLEARANCE_METRES) / -direction.z) : nominal;
    if (!(reach > spec.segmentLengthMetres) || reach * BUDGET_MARGIN / spec.segmentLengthMetres > budget.remaining) continue;
    const points = channelPath(random, junction, add(junction, scaled(direction, reach)), spec, budget, { endAtGround: true, budget: budget.remaining });
    const channel = {
      points,
      main: false,
      level,
      energyScale: spec.branchEnergyRatio ** level,
      emissionOffsetMetres: parent.emissionOffsetMetres + junctionArc,
      mainLength: parent.mainLength
    };
    channels.push(channel);
    growBranches(random, spec, budget, channel, level + 1, channels);
  }
}

/**
 * One flash as channels in space and strokes in time. The main channel runs from start to end
 * with recursive branches that radiate in the first stroke. A ground flash's later strokes follow
 * the previous stroke's path to ground, or with the given probability strike a new ground point
 * through a new lower channel that joins the main channel. Strokes are separated by lognormal
 * intervals around the median. Segment energies vary by a mean-preserving lognormal factor.
 * Every stroke lists its route: which channels it lights, from which arc, and with which
 * emission offset.
 */
export function lightningFlash(input) {
  const spec = { groundAt: FLAT_GROUND, ...input };
  const random = createRandom(spec.seed);
  const budget = { remaining: MAXIMUM_SEGMENTS_PER_EMITTER };
  const mainPoints = channelPath(random, spec.baseMetres, spec.topMetres, spec, budget);
  if (spec.branchBudget !== undefined) budget.remaining = Math.min(budget.remaining, spec.branchBudget);
  const mainLength = pathLength(mainPoints);
  const main = { points: mainPoints, main: true, level: 0, energyScale: 1, emissionOffsetMetres: 0, mainLength };
  const channels = [main];
  growBranches(random, spec, budget, main, 1, channels);
  const branchIndices = channels.map((_, index) => index).slice(1);

  const ground = spec.type === 'cloud-to-ground';
  // In-cloud channels start at the top once the first return stroke has reached it.
  const inCloud = [];
  if (ground && spec.inCloudLengthMetres > 0) {
    const firstAzimuth = 2 * Math.PI * random();
    for (let index = 0; index < IN_CLOUD_CHANNELS; index += 1) {
      const azimuth = firstAzimuth + index * Math.PI + toRadians((2 * random() - 1) * IN_CLOUD_SPREAD_DEGREES);
      const elevation = toRadians((2 * random() - 1) * IN_CLOUD_ELEVATION_DEGREES);
      const reach = spec.inCloudLengthMetres * uniform(random, IN_CLOUD_LENGTH_SHARE);
      const direction = { x: Math.cos(elevation) * Math.cos(azimuth), y: Math.cos(elevation) * Math.sin(azimuth), z: Math.sin(elevation) };
      if (reach * BUDGET_MARGIN / spec.segmentLengthMetres > budget.remaining) continue;
      const points = channelPath(random, spec.topMetres, add(spec.topMetres, scaled(direction, reach)), spec, budget);
      channels.push({ points, main: false, inCloud: true, level: 1, energyScale: spec.inCloudEnergyRatio, emissionOffsetMetres: 0, mainLength });
      inCloud.push({ channel: channels.length - 1, fromArc: 0, offsetMetres: 0, offsetSeconds: mainLength / spec.channelSpeedMetresPerSecond, speedMetresPerSecond: spec.inCloudSpeedMetresPerSecond });
    }
  }
  const strokes = [];
  let route = [{ channel: 0, fromArc: 0, offsetMetres: 0 }];
  let offsetSeconds = 0;
  for (let stroke = 0; stroke < spec.strokeCount; stroke += 1) {
    if (stroke > 0) {
      offsetSeconds += spec.strokeIntervalSeconds * Math.exp(spec.strokeIntervalSpread * normalDeviate(random));
      if (ground && random() < spec.newTerminationProbability) {
        const junctionArc = mainLength * uniform(random, TERMINATION_JUNCTION_RANGE);
        const { point: junction } = pointAtArc(mainPoints, junctionArc);
        const above = junction.z - spec.groundAt(junction.x, junction.y);
        const reach = above * uniform(random, TERMINATION_REACH_RANGE);
        const azimuth = 2 * Math.PI * random();
        const groundX = junction.x + reach * Math.cos(azimuth);
        const groundY = junction.y + reach * Math.sin(azimuth);
        const groundPoint = { x: groundX, y: groundY, z: spec.groundAt(groundX, groundY) };
        if (above * BUDGET_MARGIN / spec.segmentLengthMetres < budget.remaining) {
          const lower = channelPath(random, groundPoint, junction, spec, budget);
          channels.push({ points: lower, main: true, level: 0, energyScale: 1, emissionOffsetMetres: 0, mainLength, termination: true });
          route = [
            { channel: channels.length - 1, fromArc: 0, offsetMetres: 0 },
            { channel: 0, fromArc: junctionArc, offsetMetres: pathLength(lower) }
          ];
        }
      }
    }
    const lit = stroke === 0 ? [...route, ...branchIndices.map(channel => ({ channel, fromArc: 0, offsetMetres: channels[channel].emissionOffsetMetres })), ...inCloud] : route;
    strokes.push({ offsetSeconds, energyScale: stroke === 0 ? 1 : spec.subsequentStrokeEnergyRatio, route: lit });
  }

  for (const channel of channels) {
    channel.segments = segmentsFromPoints(channel.points);
    channel.lengthMetres = pathLength(channel.points);
    channel.energyVariation = Float64Array.from(channel.segments, () => Math.exp(spec.energyVariation * normalDeviate(random) - spec.energyVariation ** 2 / 2));
  }
  return {
    type: spec.type,
    startSeconds: spec.startSeconds,
    channelSpeedMetresPerSecond: spec.channelSpeedMetresPerSecond,
    currentDecayHeightMetres: ground ? spec.currentDecayHeightMetres : Infinity,
    energyJoulesPerMetre: spec.energyJoulesPerMetre,
    strokes,
    channels
  };
}

/**
 * When a channel point at arc `arcMetres` of a stroke's route step emits, in scene seconds: the
 * stroke's onset, the step's own delay, and the travel of the discharge along the channel at the
 * step's speed (the flash's channel speed unless the step has its own).
 */
export function emissionSeconds(flash, stroke, step, arcMetres) {
  return flash.startSeconds + stroke.offsetSeconds + (step.offsetSeconds ?? 0)
    + (step.offsetMetres + arcMetres - step.fromArc) / (step.speedMetresPerSecond ?? flash.channelSpeedMetresPerSecond);
}

/** Class C: an in-cloud channel's energy per metre falls to e^(−IN_CLOUD_TAPER) at its far end. */
const IN_CLOUD_TAPER = 4;

/**
 * The share of a flash's energy per metre that a segment deposits. Return-stroke channels: class B
 * for the decay (MTLE return-stroke model: the current falls as I(z) = I₀·e^(−z/λ) with height;
 * λ ≈ 2 km is the commonly used value, not yet verified against Nucci et al. 1988), class C for the
 * energy following the current squared, e^(−2z/λ). In-cloud channels are not return-stroke paths;
 * they thin out toward their tips (class C).
 */
export function segmentEnergyShare(flash, channel, segment) {
  if (channel.inCloud) return Math.exp(-IN_CLOUD_TAPER * segment.arcMetres / channel.lengthMetres);
  return Math.exp(-2 * Math.max(0, segment.centreMetres.z) / flash.currentDecayHeightMetres);
}

/**
 * Class B: Few's relaxation radius R₀ = sqrt(E_l / (π·p)) for an energy per unit length E_l
 * released into air at ambient pressure p.
 */
export const relaxationRadiusMetres = (energyJoulesPerMetre, pressurePa) => Math.sqrt(energyJoulesPerMetre / (Math.PI * pressurePa));

/**
 * The N-wave duration and the extra weak-shock decay of a channel segment's pulse after r metres:
 * the period grows from τ₀ at 10 R₀ until the wave turns linear at `limitRadii` relaxation radii.
 */
export function weakShockPulse(relaxationRadius, sourcePeriodSeconds, metres, limitRadii) {
  const x = Math.min(limitRadii, Math.max(WEAK_SHOCK.startRadii, metres / relaxationRadius));
  const period = WEAK_SHOCK.periodGrowth * sourcePeriodSeconds * x ** WEAK_SHOCK.periodExponent;
  return {
    durationSeconds: nWaveDurationForPeak(1 / period),
    amplitudeScale: (x / WEAK_SHOCK.startRadii) ** WEAK_SHOCK.extraDecayExponent
  };
}

/**
 * Point sources of flashes. Each lit segment radiates an N-wave whose fundamental period is
 * τ₀ = k·R₀/c at the local ambient pressure and lengthens with distance (class B, ReVelle). Its
 * amplitude carries the acoustic share η of the segment's energy as an isotropic pulse of the
 * source period (class C): P·1 m = sqrt(3ρc·η·E·ℓ / (4π·T₀)). The segment radiates with the
 * directivity of its straight element ℓs (class C).
 */
export function flashSources(flashes, physics, air, sources = []) {
  const speed = speedOfSoundMetresPerSecond(air.temperatureCelsius);
  const groundPressurePa = air.pressureKpa * 1000;
  const density = airDensityKilogramsPerCubicMetre(groundPressurePa, air.temperatureCelsius);
  flashes.forEach((flash, flashIndex) => {
    for (const stroke of flash.strokes) {
      for (const step of stroke.route) {
        const channel = flash.channels[step.channel];
        channel.segments.forEach((segment, segmentIndex) => {
          if (segment.arcMetres < step.fromArc) return;
          const energy = flash.energyJoulesPerMetre * stroke.energyScale * channel.energyScale * channel.energyVariation[segmentIndex]
            * segmentEnergyShare(flash, channel, segment);
          const pressurePa = pressureAtHeightPa(air, segment.centreMetres.z);
          const radius = relaxationRadiusMetres(energy, pressurePa);
          const sourcePeriodSeconds = physics.periodCoefficient * radius / speed;
          const reference = weakShockPulse(radius, sourcePeriodSeconds, 0, physics.weakShockLimitRadii);
          const acousticEnergy = physics.acousticEfficiency * energy * segment.lengthMetres;
          sources.push({
            flash: flashIndex,
            positionMetres: segment.centreMetres,
            direction: segment.direction,
            elementMetres: Math.min(physics.straightLengthMetres, segment.lengthMetres),
            emissionSeconds: emissionSeconds(flash, stroke, step, segment.arcMetres),
            amplitudePaMetres: Math.sqrt(3 * density * speed * acousticEnergy / (4 * Math.PI * reference.durationSeconds)),
            pulse: 'n-wave',
            weakShock: { relaxationRadius: radius, sourcePeriodSeconds, limitRadii: physics.weakShockLimitRadii },
            durationSeconds: reference.durationSeconds,
            decay: 0,
            spanSeconds: weakShockPulse(radius, sourcePeriodSeconds, Infinity, physics.weakShockLimitRadii).durationSeconds,
            linearRadiusMetres: radius * WEAK_SHOCK.startRadii
          });
        });
      }
    }
  });
  return sources;
}

/**
 * The flash of a single lightning emitter over a terrain surface. A ground flash's ground point is
 * stored above the ground (at it) and lands on the surface; heights in the cloud are above the datum.
 */
export function lightningEmitterFlashes(emitter, surface = null) {
  const groundAt = surface ? surface.heightAt : FLAT_GROUND;
  const ground = emitter.flashType === 'cloud-to-ground';
  const baseMetres = ground ? { ...emitter.baseMetres, z: groundAt(emitter.baseMetres.x, emitter.baseMetres.y) + emitter.baseMetres.z } : emitter.baseMetres;
  return [lightningFlash({ ...emitter, baseMetres, groundAt, type: emitter.flashType })];
}
