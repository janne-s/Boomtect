import { airDensityKilogramsPerCubicMetre, pressureAtHeightPa, speedOfSoundMetresPerSecond } from './air.js';
import { MAXIMUM_SEGMENTS_PER_EMITTER } from './constants.js';
import { friedlanderSpanSeconds, friedlanderSpectrum, nWaveDurationForPeak, nWaveSpectrum } from './pulses.js';
import { createRandom, normalDeviate } from './random.js';

export const EMITTER_KINDS = Object.freeze(['lightning', 'blast']);

/** Class C: propagation from a channel is treated as linear beyond this many relaxation radii. */
const LIGHTNING_LINEAR_RELAXATION_RADII = 10;
/** Class B: Kinney & Graham (1985) peak overpressure fit, ΔP/P = f(Z) with Z in m/kg^(1/3). */
const KINNEY_GRAHAM = Object.freeze({ scale: 808, numerator: 4.5, denominators: [.048, .32, 1.35] });

const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scaled = (a, factor) => ({ x: a.x * factor, y: a.y * factor, z: a.z * factor });
const length = a => Math.hypot(a.x, a.y, a.z);
const unit = a => scaled(a, 1 / length(a));
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

export function kinneyGrahamOverpressureRatio(scaledDistance) {
  const { scale, numerator, denominators } = KINNEY_GRAHAM;
  const top = scale * (1 + (scaledDistance / numerator) ** 2);
  return top / denominators.reduce((product, value) => product * Math.sqrt(1 + (scaledDistance / value) ** 2), 1);
}

/** Two unit vectors perpendicular to `direction` and to each other. */
function perpendicularBasis(direction) {
  const helper = Math.abs(direction.z) < .9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const first = unit(cross(direction, helper));
  return [first, cross(direction, first)];
}

/**
 * Class C: a deterministic tortuous channel from base to top. Each segment leaves the direction
 * toward the top by a half-normal angle with the given mean and a uniform azimuth, so the channel
 * wanders but always ends at the top. The channel stays at or above the ground.
 */
export function lightningChannelPoints({ baseMetres, topMetres, segmentLengthMetres, tortuosityDegrees, seed }) {
  const total = length(subtract(topMetres, baseMetres));
  if (tortuosityDegrees === 0) {
    const count = Math.max(1, Math.ceil(total / segmentLengthMetres));
    return Array.from({ length: count + 1 }, (_, index) => add(baseMetres, scaled(subtract(topMetres, baseMetres), index / count)));
  }
  const random = createRandom(seed);
  const sigma = tortuosityDegrees * Math.PI / 180 * Math.sqrt(Math.PI / 2);
  const points = [{ ...baseMetres }];
  let position = { ...baseMetres };
  while (points.length <= MAXIMUM_SEGMENTS_PER_EMITTER) {
    const remaining = length(subtract(topMetres, position));
    if (remaining <= segmentLengthMetres) {
      points.push({ ...topMetres });
      return points;
    }
    const angle = Math.abs(normalDeviate(random)) * sigma;
    const azimuth = 2 * Math.PI * random();
    const toward = unit(subtract(topMetres, position));
    const [first, second] = perpendicularBasis(toward);
    const direction = add(scaled(toward, Math.cos(angle)),
      scaled(add(scaled(first, Math.cos(azimuth)), scaled(second, Math.sin(azimuth))), Math.sin(angle)));
    position = add(position, scaled(direction, segmentLengthMetres));
    if (position.z < 0) position.z = -position.z;
    points.push({ ...position });
  }
  throw new RangeError('The lightning channel needs more segments than the supported limit.');
}

/** Segments between consecutive points, with arc length from the base to each segment centre. */
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

/**
 * Class B: Few's relaxation radius R₀ = sqrt(E_l / (π·p)) for an energy per unit length E_l
 * released into air at ambient pressure p.
 */
export const relaxationRadiusMetres = (energyJoulesPerMetre, pressurePa) => Math.sqrt(energyJoulesPerMetre / (Math.PI * pressurePa));

/**
 * The per-stroke source description of a lightning emitter. Each segment radiates an N-wave whose
 * spectral peak is κ·c/R₀ at the local ambient pressure (class B, Few). Its amplitude carries the
 * acoustic share η of the segment's energy as an isotropic far-field pulse (class C):
 * P·1 m = sqrt(3ρc·η·E_l·ℓ / (4π·T)).
 */
export function lightningSources(emitter, air) {
  const points = lightningChannelPoints(emitter);
  const segments = segmentsFromPoints(points);
  const speed = speedOfSoundMetresPerSecond(air.temperatureCelsius);
  const groundPressurePa = air.pressureKpa * 1000;
  const density = airDensityKilogramsPerCubicMetre(groundPressurePa, air.temperatureCelsius);
  const strokes = Array.from({ length: emitter.strokeCount }, (_, index) => ({
    index,
    startSeconds: index * emitter.strokeIntervalSeconds,
    energyJoulesPerMetre: emitter.energyJoulesPerMetre * (index === 0 ? 1 : emitter.subsequentStrokeEnergyRatio)
  }));
  const sources = [];
  for (const stroke of strokes) {
    for (const segment of segments) {
      const pressurePa = pressureAtHeightPa(groundPressurePa, air.temperatureCelsius, segment.centreMetres.z);
      const radius = relaxationRadiusMetres(stroke.energyJoulesPerMetre, pressurePa);
      const peakFrequencyHz = emitter.frequencyCoefficient * speed / radius;
      const durationSeconds = nWaveDurationForPeak(peakFrequencyHz);
      const acousticEnergy = emitter.acousticEfficiency * stroke.energyJoulesPerMetre * segment.lengthMetres;
      const amplitudePaMetres = Math.sqrt(3 * density * speed * acousticEnergy / (4 * Math.PI * durationSeconds));
      sources.push({
        stroke: stroke.index,
        positionMetres: segment.centreMetres,
        direction: segment.direction,
        lengthMetres: segment.lengthMetres,
        emissionSeconds: stroke.startSeconds + segment.arcMetres / emitter.returnStrokeSpeedMetresPerSecond,
        amplitudePaMetres,
        spanSeconds: durationSeconds,
        linearRadiusMetres: radius * LIGHTNING_LINEAR_RELAXATION_RADII,
        spectrum: frequencyHz => nWaveSpectrum(frequencyHz, durationSeconds)
      });
    }
  }
  return { points, segmentCount: segments.length, sources };
}

/**
 * The source description of a blast: one point with a Friedlander waveform. Its amplitude comes
 * from the Kinney & Graham fit at the linearization scaled distance, from where propagation is
 * linear (class B). The positive phase scales with the cube root of the charge (Hopkinson–Cranz,
 * class B) from a reference duration (class C until the Kinney & Graham duration fit is verified).
 */
export function blastSources(emitter, air) {
  const cubeRoot = Math.cbrt(emitter.chargeKilograms);
  const linearRadiusMetres = emitter.linearScaledDistance * cubeRoot;
  const overpressurePa = air.pressureKpa * 1000 * kinneyGrahamOverpressureRatio(emitter.linearScaledDistance);
  const positiveDurationSeconds = emitter.durationSecondsPerCubeRootKilogram * cubeRoot;
  return {
    points: [emitter.positionMetres],
    segmentCount: 1,
    sources: [{
      stroke: 0,
      positionMetres: emitter.positionMetres,
      direction: null,
      lengthMetres: 0,
      emissionSeconds: 0,
      amplitudePaMetres: overpressurePa * linearRadiusMetres,
      spanSeconds: friedlanderSpanSeconds(positiveDurationSeconds, emitter.decay),
      linearRadiusMetres,
      spectrum: frequencyHz => friedlanderSpectrum(frequencyHz, positiveDurationSeconds, emitter.decay)
    }]
  };
}

export function emitterSources(emitter, air) {
  if (emitter.kind === 'lightning') return lightningSources(emitter, air);
  if (emitter.kind === 'blast') return blastSources(emitter, air);
  throw new RangeError(`Unknown emitter kind: ${emitter.kind}`);
}
