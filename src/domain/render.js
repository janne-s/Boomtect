import { atmosphericAbsorptionNepersPerMetre, speedOfSoundMetresPerSecond } from './air.js';
import { MAXIMUM_RENDER_SECONDS, MODEL_VERSION } from './constants.js';
import { emitterSources } from './emitters.js';
import { fft, nextPowerOfTwo } from './fft.js';
import { sphericalReflectionCoefficient } from './ground.js';
import { riseSmoothing } from './pulses.js';

/** Samples kept before each arrival for zero-phase smoothing, absorption, and directivity. */
const PRE_ROLL_SAMPLES = 512;
/** Samples kept after each pulse for the ground-reflection response to settle. */
const TAIL_GUARD_SAMPLES = 4096;
/** Room for later paths of the same source, such as the ground reflection, in one block. */
const GROUP_ROOM_SAMPLES = 2048;
/** Attenuation beyond which a bin no longer contributes: 14 Np ≈ 122 dB. */
const NEGLIGIBLE_NEPERS = 14;
const NEGLIGIBLE_SMOOTHING = 1e-7;
const GROUND_GRID_POINTS = 64;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const mirrored = point => ({ x: point.x, y: point.y, z: -point.z });

export const MISSING_PHENOMENA = Object.freeze([
  'Terrain and buildings',
  'Diffraction',
  'Temperature stratification and refraction',
  'Wind and turbulence',
  'Nonlinear propagation beyond the linearization radius',
  'Absolute calibration of sound pressure level'
]);

/** Expands every enabled emitter into point sources. Pure and deterministic from the scene. */
export function prepareScene(scene) {
  const air = scene.air;
  return scene.emitters.filter(emitter => emitter.enabled).map(emitter => ({ emitter, ...emitterSources(emitter, air) }));
}

/** Direct and ground-reflected paths from one point source to a receiver. */
export function sourcePaths(source, receiverMetres, scene, speedOfSound) {
  const paths = [];
  const direct = distance(source.positionMetres, receiverMetres);
  paths.push({
    kind: 'direct',
    pathMetres: direct,
    seconds: source.emissionSeconds + direct / speedOfSound,
    directivityCos: directivityCosine(source.direction, source.positionMetres, receiverMetres, direct)
  });
  if (scene.ground.enabled) {
    const image = mirrored(source.positionMetres);
    const reflected = distance(image, receiverMetres);
    paths.push({
      kind: 'ground',
      pathMetres: reflected,
      seconds: source.emissionSeconds + reflected / speedOfSound,
      cosIncidence: reflected > 0 ? (source.positionMetres.z + receiverMetres.z) / reflected : 1,
      directivityCos: directivityCosine(source.direction && mirrored(source.direction), image, receiverMetres, reflected)
    });
  }
  return paths;
}

function directivityCosine(direction, from, to, pathMetres) {
  if (!direction || !(pathMetres > 0)) return 0;
  return (direction.x * (to.x - from.x) + direction.y * (to.y - from.y) + direction.z * (to.z - from.z)) / pathMetres;
}

/** Class A: far-field directivity of a uniform line element of length ℓ, sinc(π·f·ℓ·cosψ / c). */
function lineDirectivity(frequencyHz, lengthMetres, directivityCos, speedOfSound) {
  const argument = Math.PI * frequencyHz * lengthMetres * directivityCos / speedOfSound;
  return Math.abs(argument) < 1e-9 ? 1 : Math.sin(argument) / argument;
}

function blockPlan(prepared, sampleRate, speedOfSound) {
  let longestSegment = 0;
  let longestSpan = 0;
  for (const source of prepared.sources) {
    longestSegment = Math.max(longestSegment, source.lengthMetres);
    longestSpan = Math.max(longestSpan, source.spanSeconds);
  }
  const preRoll = PRE_ROLL_SAMPLES + Math.ceil(longestSegment / speedOfSound * sampleRate / 2);
  const size = nextPowerOfTwo(2 * preRoll + Math.ceil(longestSpan * sampleRate) + TAIL_GUARD_SAMPLES + GROUP_ROOM_SAMPLES);
  return { preRoll, size };
}

/** Bin-indexed tables shared by every block of one size. */
function binTables(size, sampleRate, scene, riseTimeSeconds) {
  const bins = size / 2 + 1;
  const frequency = new Float64Array(bins);
  const absorption = new Float64Array(bins);
  const smoothing = new Float64Array(bins);
  const gridPosition = new Float64Array(bins);
  const lowest = sampleRate / size;
  const ratio = Math.log((sampleRate / 2) / lowest);
  let smoothingLimit = bins;
  for (let bin = 0; bin < bins; bin += 1) {
    frequency[bin] = bin * sampleRate / size;
    absorption[bin] = scene.air.absorption ? atmosphericAbsorptionNepersPerMetre(frequency[bin], scene.air) : 0;
    smoothing[bin] = riseSmoothing(frequency[bin], riseTimeSeconds);
    if (smoothingLimit === bins && smoothing[bin] < NEGLIGIBLE_SMOOTHING) smoothingLimit = bin;
    gridPosition[bin] = bin === 0 ? 0 : Math.log(frequency[bin] / lowest) / ratio * (GROUND_GRID_POINTS - 1);
  }
  const groundFrequencies = Float64Array.from({ length: GROUND_GRID_POINTS }, (_, index) => lowest * Math.exp(ratio * index / (GROUND_GRID_POINTS - 1)));
  return { bins, frequency, absorption, smoothing, smoothingLimit, gridPosition, groundFrequencies };
}

function absorptionLimit(tables, pathMetres) {
  const { absorption, smoothingLimit } = tables;
  let low = 0;
  let high = smoothingLimit;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (absorption[middle] * pathMetres > NEGLIGIBLE_NEPERS) high = middle; else low = middle + 1;
  }
  return low;
}

/**
 * Adds one source's paths into a block spectrum. `offsetSamples` places each path's front within
 * the block; the phase ramp applies the exact fractional delay.
 */
function accumulatePaths({ source, paths, offsets, tables, size, scene, speedOfSound, real, imaginary }) {
  const { frequency, absorption, smoothing, gridPosition, groundFrequencies } = tables;
  const pulse = new Float64Array(2 * tables.smoothingLimit);
  for (let bin = 0; bin < tables.smoothingLimit; bin += 1) {
    const [re, im] = source.spectrum(frequency[bin]);
    pulse[2 * bin] = re * smoothing[bin];
    pulse[2 * bin + 1] = im * smoothing[bin];
  }
  paths.forEach((path, pathIndex) => {
    const gain = source.amplitudePaMetres / Math.max(path.pathMetres, Number.MIN_VALUE);
    const limit = absorptionLimit(tables, path.pathMetres);
    let groundRe = null;
    let groundIm = null;
    if (path.kind === 'ground') {
      groundRe = new Float64Array(GROUND_GRID_POINTS);
      groundIm = new Float64Array(GROUND_GRID_POINTS);
      groundFrequencies.forEach((value, index) => {
        [groundRe[index], groundIm[index]] = sphericalReflectionCoefficient(value, scene.ground.type, path.cosIncidence, path.pathMetres, speedOfSound);
      });
    }
    const step = -2 * Math.PI * offsets[pathIndex] / size;
    const stepRe = Math.cos(step);
    const stepIm = Math.sin(step);
    let phaseRe = 1;
    let phaseIm = 0;
    for (let bin = 0; bin < limit; bin += 1) {
      let factor = gain * Math.exp(-absorption[bin] * path.pathMetres);
      if (source.lengthMetres > 0) factor *= lineDirectivity(frequency[bin], source.lengthMetres, path.directivityCos, speedOfSound);
      let re = pulse[2 * bin] * factor;
      let im = pulse[2 * bin + 1] * factor;
      if (groundRe) {
        const position = Math.min(GROUND_GRID_POINTS - 1, gridPosition[bin]);
        const lower = Math.min(GROUND_GRID_POINTS - 2, Math.floor(position));
        const mix = position - lower;
        const qRe = groundRe[lower] + (groundRe[lower + 1] - groundRe[lower]) * mix;
        const qIm = groundIm[lower] + (groundIm[lower + 1] - groundIm[lower]) * mix;
        const nextRe = re * qRe - im * qIm;
        im = re * qIm + im * qRe;
        re = nextRe;
      }
      real[bin] += re * phaseRe - im * phaseIm;
      imaginary[bin] += re * phaseIm + im * phaseRe;
      const nextPhaseRe = phaseRe * stepRe - phaseIm * stepIm;
      phaseIm = phaseRe * stepIm + phaseIm * stepRe;
      phaseRe = nextPhaseRe;
    }
  });
}

/** Inverse transform of a continuous-time spectrum sampled at bins: x[n] = fs · IDFT(X). */
function synthesizeBlock(real, imaginary, size, sampleRate) {
  for (let bin = 1; bin < size / 2; bin += 1) {
    real[size - bin] = real[bin];
    imaginary[size - bin] = -imaginary[bin];
  }
  imaginary[0] = 0;
  imaginary[size / 2] = 0;
  fft(real, imaginary, true);
  for (let index = 0; index < size; index += 1) real[index] *= sampleRate;
  return real;
}

/**
 * Renders the pressure signal at one receiver as p_r(t) = Σ (s_i * h_i,r)(t). Each point source is
 * rendered as an analytic spectrum with exact fractional delay, 1/R spreading, optional ISO 9613-1
 * absorption, line-element directivity, and an optional spherical-wave ground reflection, then
 * overlap-added in Float64. Time zero is the first emission.
 */
export function renderReceiver(preparedEmitters, receiver, scene, { onProgress = null, isCancelled = () => false } = {}) {
  const sampleRate = scene.render.sampleRate;
  const speedOfSound = speedOfSoundMetresPerSecond(scene.air.temperatureCelsius);
  const receiverMetres = receiver.positionMetres;
  const jobs = [];
  let earliest = Infinity;
  let latest = -Infinity;
  let nonlinearPaths = 0;
  const arrivals = [];

  for (const prepared of preparedEmitters) {
    const plan = blockPlan(prepared, sampleRate, speedOfSound);
    const tables = binTables(plan.size, sampleRate, scene, prepared.emitter.riseTimeSeconds);
    for (const source of prepared.sources) {
      const paths = sourcePaths(source, receiverMetres, scene, speedOfSound);
      for (const path of paths) {
        earliest = Math.min(earliest, path.seconds);
        latest = Math.max(latest, path.seconds);
        if (path.pathMetres < source.linearRadiusMetres) nonlinearPaths += 1;
        arrivals.push({ emitterId: prepared.emitter.id, kind: path.kind, seconds: path.seconds, heightMetres: source.positionMetres.z, levelDb: 20 * Math.log10(source.amplitudePaMetres / Math.max(path.pathMetres, 1e-3)) });
      }
      jobs.push({ source, paths, plan, tables });
    }
  }
  if (!jobs.length) return emptyResult(receiver, scene, speedOfSound);

  const startSample = Math.floor(earliest * sampleRate) - Math.max(...jobs.map(job => job.plan.preRoll));
  const endSample = Math.ceil(latest * sampleRate) + Math.max(...jobs.map(job => job.plan.size));
  const frames = endSample - startSample;
  if (frames / sampleRate > MAXIMUM_RENDER_SECONDS) {
    throw new RangeError(`Arrivals at ${receiver.name} span ${(frames / sampleRate).toFixed(1)} s; the limit is ${MAXIMUM_RENDER_SECONDS} s.`);
  }
  const output = new Float64Array(frames);

  jobs.forEach((job, jobIndex) => {
    if (isCancelled()) throw new Error('cancelled');
    const { source, paths, plan, tables } = job;
    const groups = [];
    for (const path of [...paths].sort((a, b) => a.seconds - b.seconds)) {
      const group = groups.at(-1);
      const capacity = plan.size - 2 * plan.preRoll - Math.ceil(source.spanSeconds * sampleRate) - TAIL_GUARD_SAMPLES;
      if (group && (path.seconds - group.anchorSeconds) * sampleRate <= capacity) group.paths.push(path);
      else groups.push({ anchorSeconds: path.seconds, paths: [path] });
    }
    for (const group of groups) {
      const anchorSample = Math.floor(group.anchorSeconds * sampleRate);
      const real = new Float64Array(plan.size);
      const imaginary = new Float64Array(plan.size);
      const offsets = group.paths.map(path => path.seconds * sampleRate - anchorSample + plan.preRoll);
      accumulatePaths({ source, paths: group.paths, offsets, tables, size: plan.size, scene, speedOfSound, real, imaginary });
      const block = synthesizeBlock(real, imaginary, plan.size, sampleRate);
      const at = anchorSample - plan.preRoll - startSample;
      for (let index = 0; index < plan.size; index += 1) output[at + index] += block[index];
    }
    if (onProgress && (jobIndex % 32 === 0 || jobIndex === jobs.length - 1)) onProgress(jobIndex + 1, jobs.length);
  });

  const samples = new Float32Array(frames);
  let peakPa = 0;
  for (let index = 0; index < frames; index += 1) {
    const value = output[index];
    if (!Number.isFinite(value)) throw new RangeError('The render produced a non-finite sample.');
    samples[index] = value;
    peakPa = Math.max(peakPa, Math.abs(value));
  }
  return {
    receiverId: receiver.id,
    sampleRate,
    startSeconds: startSample / sampleRate,
    samples,
    peakPa,
    speedOfSound,
    arrivals,
    nonlinearPaths,
    modelVersion: MODEL_VERSION
  };
}

function emptyResult(receiver, scene, speedOfSound) {
  return {
    receiverId: receiver.id, sampleRate: scene.render.sampleRate, startSeconds: 0, samples: new Float32Array(0),
    peakPa: 0, speedOfSound, arrivals: [], nonlinearPaths: 0, modelVersion: MODEL_VERSION
  };
}
