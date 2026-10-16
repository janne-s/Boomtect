import { airDensityKilogramsPerCubicMetre, pressureAtHeightPa, speedOfSoundMetresPerSecond } from '../shared/domain/air.js';
import { PROPAGATION, THUNDER } from './constants.js';
import { weakShockPulse } from '../shared/domain/shocks.js';
import { createRandom, normalDeviate, uniform } from '../shared/domain/random.js';
import { add, deflected, distance, length, scaled, subtract, unit } from '../shared/domain/vector.js';

export const FLASH_TYPES = Object.freeze(['cloud-to-ground', 'intra-cloud']);

const BUDGET_MARGIN = 2;
const STEP_TOLERANCE = 1e-9;
const GROUND_CLEARANCE_METRES = 1;

const toRadians = degrees => degrees * Math.PI / 180;
const FLAT_GROUND = () => 0;

/** Class C. */
export function tortuousPath(random, start, target, stepMetres, tortuosityDegrees, { endAtGround = false, budget = THUNDER.maximumSegmentsPerEmitter, groundAt = FLAT_GROUND } = {}) {
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

/** Class C. */
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

function budgetedPath(random, start, end, spec, budget, options = {}) {
  const remaining = budget.remaining;
  try {
    return channelPath(random, start, end, spec, budget, options);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    budget.remaining = remaining;
    return null;
  }
}

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

function growBranches(random, spec, budget, parent, level, channels) {
  if (level > spec.branchDepth) return;
  const count = Math.round(spec.branchCount * THUNDER.channel.subBranchCountShare ** (level - 1));
  const parentLength = pathLength(parent.points);
  const ground = spec.type === 'cloud-to-ground';
  for (let branch = 0; branch < count; branch += 1) {
    const junctionArc = parentLength * uniform(random, THUNDER.channel.branchJunctionRange);
    const { point: junction, direction: parentDirection } = pointAtArc(parent.points, junctionArc);
    const nominal = spec.branchLengthRatio * THUNDER.channel.subBranchLengthShare ** (level - 1) * parent.mainLength * uniform(random, [THUNDER.channel.branchLengthMinimumShare, 1]);
    let direction;
    if (level > 1) direction = deflected(parentDirection, toRadians(uniform(random, THUNDER.channel.subBranchAngleDegrees)), 2 * Math.PI * random());
    else if (ground) direction = deflected({ x: 0, y: 0, z: -1 }, toRadians(uniform(random, THUNDER.channel.groundBranchAngleDegrees)), 2 * Math.PI * random());
    else {
      const azimuth = 2 * Math.PI * random();
      const elevation = toRadians((2 * random() - 1) * THUNDER.channel.cloudBranchElevationDegrees);
      direction = { x: Math.cos(elevation) * Math.cos(azimuth), y: Math.cos(elevation) * Math.sin(azimuth), z: Math.sin(elevation) };
    }
    const reach = direction.z < 0 ? Math.min(nominal, (junction.z - spec.groundAt(junction.x, junction.y) - GROUND_CLEARANCE_METRES) / -direction.z) : nominal;
    if (!(reach > spec.segmentLengthMetres) || reach * BUDGET_MARGIN / spec.segmentLengthMetres > budget.remaining) continue;
    const points = budgetedPath(random, junction, add(junction, scaled(direction, reach)), spec, budget, { endAtGround: true, budget: budget.remaining });
    if (!points) continue;
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

export function lightningFlash(input) {
  const spec = { groundAt: FLAT_GROUND, ...input };
  const random = createRandom(spec.seed);
  const budget = { remaining: THUNDER.maximumSegmentsPerEmitter };
  const mainPoints = channelPath(random, spec.baseMetres, spec.topMetres, spec, budget);
  if (spec.branchBudget !== undefined) budget.remaining = Math.min(budget.remaining, spec.branchBudget);
  const mainLength = pathLength(mainPoints);
  const main = { points: mainPoints, main: true, level: 0, energyScale: 1, emissionOffsetMetres: 0, mainLength };
  const channels = [main];
  growBranches(random, spec, budget, main, 1, channels);
  const branchIndices = channels.map((_, index) => index).slice(1);

  const ground = spec.type === 'cloud-to-ground';
  const inCloud = [];
  if (ground && spec.inCloudLengthMetres > 0) {
    const firstAzimuth = 2 * Math.PI * random();
    for (let index = 0; index < THUNDER.channel.inCloudChannels; index += 1) {
      const azimuth = firstAzimuth + index * Math.PI + toRadians((2 * random() - 1) * THUNDER.channel.inCloudSpreadDegrees);
      const elevation = toRadians((2 * random() - 1) * THUNDER.channel.inCloudElevationDegrees);
      const reach = spec.inCloudLengthMetres * uniform(random, THUNDER.channel.inCloudLengthShare);
      const direction = { x: Math.cos(elevation) * Math.cos(azimuth), y: Math.cos(elevation) * Math.sin(azimuth), z: Math.sin(elevation) };
      if (reach * BUDGET_MARGIN / spec.segmentLengthMetres > budget.remaining) continue;
      const points = budgetedPath(random, spec.topMetres, add(spec.topMetres, scaled(direction, reach)), spec, budget);
      if (!points) continue;
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
        const junctionArc = mainLength * uniform(random, THUNDER.channel.terminationJunctionRange);
        const { point: junction } = pointAtArc(mainPoints, junctionArc);
        const above = junction.z - spec.groundAt(junction.x, junction.y);
        const reach = above * uniform(random, THUNDER.channel.terminationReachRange);
        const azimuth = 2 * Math.PI * random();
        const groundX = junction.x + reach * Math.cos(azimuth);
        const groundY = junction.y + reach * Math.sin(azimuth);
        const groundPoint = { x: groundX, y: groundY, z: spec.groundAt(groundX, groundY) };
        const lower = above * BUDGET_MARGIN / spec.segmentLengthMetres < budget.remaining ? budgetedPath(random, groundPoint, junction, spec, budget) : null;
        if (lower) {
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

export function emissionSeconds(flash, stroke, step, arcMetres) {
  return flash.startSeconds + stroke.offsetSeconds + (step.offsetSeconds ?? 0)
    + (step.offsetMetres + arcMetres - step.fromArc) / (step.speedMetresPerSecond ?? flash.channelSpeedMetresPerSecond);
}

/** Class B: MTLE decay, λ ≈ 2 km not yet verified against Nucci et al. 1988; energy as current squared and the in-cloud taper class C. */
export function segmentEnergyShare(flash, channel, segment) {
  if (channel.inCloud) return Math.exp(-THUNDER.channel.inCloudTaper * segment.arcMetres / channel.lengthMetres);
  return Math.exp(-2 * Math.max(0, segment.centreMetres.z) / flash.currentDecayHeightMetres);
}

/** Class B: Few's relaxation radius. */
export const relaxationRadiusMetres = (energyJoulesPerMetre, pressurePa) => Math.sqrt(energyJoulesPerMetre / (Math.PI * pressurePa));

/** Class B: ReVelle's period; amplitude and directivity class C. */
export function flashSources(flashes, physics, air, sources = [], firstFlash = 0) {
  const speed = speedOfSoundMetresPerSecond(air.temperatureCelsius);
  const groundPressurePa = air.pressureKpa * 1000;
  const density = airDensityKilogramsPerCubicMetre(groundPressurePa, air.temperatureCelsius);
  flashes.forEach((flash, flashIndex) => {
    for (const stroke of flash.strokes) {
      for (const step of stroke.route) {
        const channel = flash.channels[step.channel];
        const merge = physics.sourceMerge ?? 1;
        const energyOf = (segment, segmentIndex) => flash.energyJoulesPerMetre * stroke.energyScale * channel.energyScale * channel.energyVariation[segmentIndex]
          * segmentEnergyShare(flash, channel, segment);
        channel.segments.forEach((_, firstIndex) => {
          if (firstIndex % merge !== 0) return;
          const group = [];
          for (let index = firstIndex; index < Math.min(channel.segments.length, firstIndex + merge); index += 1) {
            if (channel.segments[index].arcMetres >= step.fromArc) group.push(index);
          }
          if (!group.length) return;
          const segmentIndex = group[group.length >> 1];
          const segment = channel.segments[segmentIndex];
          const energy = energyOf(segment, segmentIndex);
          const pressurePa = pressureAtHeightPa(air, segment.centreMetres.z);
          const radius = relaxationRadiusMetres(energy, pressurePa);
          const sourcePeriodSeconds = physics.periodCoefficient * radius / speed;
          const reference = weakShockPulse(radius, sourcePeriodSeconds, 0, physics.weakShockLimitRadii);
          const acousticEnergy = group.length === 1 ? physics.acousticEfficiency * energy * segment.lengthMetres
            : physics.acousticEfficiency * group.reduce((sum, index) => sum + energyOf(channel.segments[index], index) * channel.segments[index].lengthMetres, 0);
          sources.push({
            flash: firstFlash + flashIndex,
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
            linearRadiusMetres: radius * PROPAGATION.weakShock.startRadii
          });
        });
      }
    }
  });
  return sources;
}

export function lightningEmitterFlashes(emitter, surface = null) {
  const groundAt = surface ? surface.heightAt : FLAT_GROUND;
  const ground = emitter.flashType === 'cloud-to-ground';
  const baseMetres = ground ? { ...emitter.baseMetres, z: groundAt(emitter.baseMetres.x, emitter.baseMetres.y) + emitter.baseMetres.z } : emitter.baseMetres;
  return [lightningFlash({ ...emitter, baseMetres, groundAt, type: emitter.flashType })];
}
