import { atmosphericAbsorptionNepersPerMetre, speedOfSoundMetresPerSecond } from './air.js';
import { ambisonicDirection, channelCount, encodeDirection } from './ambisonics.js';
import { MAXIMUM_RENDER_SECONDS, MAXIMUM_SOURCES, MODEL_VERSION } from './constants.js';
import { emitterSources } from './emitters.js';
import { fft, nextPowerOfTwo } from './fft.js';
import { sphericalReflectionCoefficient } from './ground.js';
import { weakShockPulse } from './lightning.js';
import { riseSmoothing } from './pulses.js';
import { createRandom, normalDeviate } from './random.js';

/** Samples kept before each arrival for zero-phase smoothing, absorption, and directivity. */
const PRE_ROLL_SAMPLES = 512;
/** Samples kept after each pulse for the ground-reflection response to settle. */
const TAIL_GUARD_SAMPLES = 2048;
/** Attenuation beyond which a bin no longer contributes: 14 Np ≈ 122 dB. */
const NEGLIGIBLE_NEPERS = 14;
const NEGLIGIBLE_SMOOTHING = 1e-7;
const GROUND_GRID_POINTS = 64;
/** Knots of the seeded turbulent phase curve across frequency; the grid interpolates between them. */
const TURBULENCE_KNOTS = 9;
const SMALL_ARGUMENT = 1e-4;

const PATH_DIRECT = 0;
const PATH_GROUND = 1;

export const MISSING_PHENOMENA = Object.freeze([
  'Terrain, buildings, and clouds as reflectors',
  'Diffraction',
  'Temperature stratification and refraction',
  'Wind and turbulence',
  'Nonlinear propagation beyond the linearization radius',
  'Absolute calibration of sound pressure level'
]);

/** Expands every enabled emitter into point sources. Pure and deterministic from the scene. */
export function prepareScene(scene) {
  const prepared = scene.emitters.filter(emitter => emitter.enabled).map(emitter => ({ emitter, ...emitterSources(emitter, scene.air) }));
  const count = prepared.reduce((sum, item) => sum + item.sources.length, 0);
  if (count > MAXIMUM_SOURCES) throw new RangeError(`The scene has ${count} point sources; the limit is ${MAXIMUM_SOURCES}.`);
  return prepared;
}

/**
 * Every direct and ground-reflected path from the prepared sources to one receiver, as parallel
 * typed arrays. Order is emitter, source, then direct before ground, so it is deterministic.
 */
export function receiverPaths(preparedEmitters, receiver, scene) {
  const speed = speedOfSoundMetresPerSecond(scene.air.temperatureCelsius);
  const perSource = scene.ground.enabled ? 2 : 1;
  const count = preparedEmitters.reduce((sum, item) => sum + item.sources.length, 0) * perSource;
  const paths = {
    count,
    emitter: new Uint16Array(count),
    source: new Uint32Array(count),
    kind: new Uint8Array(count),
    seconds: new Float64Array(count),
    metres: new Float64Array(count),
    directivityCos: new Float64Array(count),
    cosIncidence: new Float64Array(count),
    duration: new Float64Array(count),
    amplitudeScale: new Float64Array(count),
    direction: new Float64Array(3 * count)
  };
  const r = receiver.positionMetres;
  let index = 0;
  preparedEmitters.forEach((prepared, emitterIndex) => {
    prepared.sources.forEach((source, sourceIndex) => {
      const p = source.positionMetres;
      const d = source.direction;
      for (let kind = 0; kind < perSource; kind += 1) {
        const sign = kind === PATH_GROUND ? -1 : 1;
        const dx = r.x - p.x;
        const dy = r.y - p.y;
        const dz = r.z - sign * p.z;
        const metres = Math.hypot(dx, dy, dz);
        paths.emitter[index] = emitterIndex;
        paths.source[index] = sourceIndex;
        paths.kind[index] = kind;
        paths.metres[index] = metres;
        paths.seconds[index] = source.emissionSeconds + metres / speed;
        paths.directivityCos[index] = d && metres > 0 ? (d.x * dx + d.y * dy + sign * d.z * dz) / metres : 0;
        paths.cosIncidence[index] = metres > 0 ? (p.z + r.z) / metres : 1;
        const toward = metres > 0 ? ambisonicDirection(-dx / metres, -dy / metres, -dz / metres) : [1, 0, 0];
        paths.direction.set(toward, 3 * index);
        if (source.weakShock) {
          const { relaxationRadius, sourcePeriodSeconds, limitRadii } = source.weakShock;
          const pulse = weakShockPulse(relaxationRadius, sourcePeriodSeconds, metres, limitRadii);
          paths.duration[index] = pulse.durationSeconds;
          paths.amplitudeScale[index] = pulse.amplitudeScale;
        } else {
          paths.duration[index] = source.durationSeconds;
          paths.amplitudeScale[index] = 1;
        }
        index += 1;
      }
    });
  });
  return paths;
}

/** Arrival time, source height, and geometric level of every path, for the arrival diagram. */
export function arrivalTable(preparedEmitters, receiver, scene) {
  const paths = receiverPaths(preparedEmitters, receiver, scene);
  const heights = new Float32Array(paths.count);
  const levels = new Float32Array(paths.count);
  for (let index = 0; index < paths.count; index += 1) {
    const source = preparedEmitters[paths.emitter[index]].sources[paths.source[index]];
    heights[index] = source.positionMetres.z;
    levels[index] = 20 * Math.log10(source.amplitudePaMetres * paths.amplitudeScale[index] / Math.max(paths.metres[index], 1e-3));
  }
  return { count: paths.count, seconds: paths.seconds, heights, levels, kinds: paths.kind };
}

/**
 * Class B (Clifford & Lataitis 1983, as summarized by Salomons 2001; verify): turbulence with
 * mean-square refractive-index fluctuation ⟨μ²⟩ and scale L gives a phase variance
 * σ² = A·√π·⟨μ²⟩·k²·R·L, with A = 0.5 when R > kL² and 1 otherwise. The direct and reflected rays,
 * separated by about h = 2·hs·hr/(hs + hr), share part of it: ρ = (√π/2)(L/h)·erf(h/L). Their phase
 * difference therefore varies with variance 2σ²(1 − ρ).
 */
export function turbulentPhaseVariance(frequencyHz, metres, sourceHeight, receiverHeight, air, speed) {
  if (!(air.turbulenceStrength > 0)) return 0;
  const k = 2 * Math.PI * frequencyHz / speed;
  const scale = air.turbulenceScaleMetres;
  const factor = metres > k * scale * scale ? .5 : 1;
  const variance = factor * Math.sqrt(Math.PI) * air.turbulenceStrength * k * k * metres * scale;
  const separation = sourceHeight + receiverHeight > 0 ? 2 * sourceHeight * receiverHeight / (sourceHeight + receiverHeight) : 0;
  const shared = separation > 0 ? Math.sqrt(Math.PI) / 2 * (scale / separation) * erf(separation / scale) : 1;
  return 2 * variance * Math.max(0, 1 - shared);
}

/** Abramowitz & Stegun 7.1.26, |error| < 1.5e-7. */
function erf(x) {
  const t = 1 / (1 + .3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/**
 * Frame layout of one emitter at one receiver: hop H and block 2H hold any of its paths with
 * pre-roll and tail. It depends on all of the emitter's paths, so every time range shares it.
 */
function framePlan(prepared, emitterIndex, paths, sampleRate, speed, scene) {
  let longestElement = 0;
  let longestSpan = 0;
  for (const source of prepared.sources) longestElement = Math.max(longestElement, source.elementMetres);
  for (let index = 0; index < paths.count; index += 1) {
    if (paths.emitter[index] !== emitterIndex) continue;
    const source = prepared.sources[paths.source[index]];
    longestSpan = Math.max(longestSpan, source.weakShock ? paths.duration[index] : source.spanSeconds);
  }
  const preRoll = PRE_ROLL_SAMPLES + Math.ceil(longestElement / speed * sampleRate / 2);
  const hop = nextPowerOfTwo(preRoll + Math.ceil(longestSpan * sampleRate) + TAIL_GUARD_SAMPLES);
  const size = 2 * hop;
  const bins = hop + 1;
  const absorption = new Float64Array(bins);
  const smoothing = new Float64Array(bins);
  const gridPosition = new Float64Array(bins);
  const lowest = sampleRate / size;
  const ratio = Math.log((sampleRate / 2) / lowest);
  let smoothingLimit = bins;
  for (let bin = 0; bin < bins; bin += 1) {
    const frequency = bin * sampleRate / size;
    absorption[bin] = scene.air.absorption ? atmosphericAbsorptionNepersPerMetre(frequency, scene.air) : 0;
    smoothing[bin] = riseSmoothing(frequency, prepared.emitter.riseTimeSeconds);
    if (smoothingLimit === bins && smoothing[bin] < NEGLIGIBLE_SMOOTHING) smoothingLimit = bin;
    gridPosition[bin] = bin === 0 ? 0 : Math.min(GROUND_GRID_POINTS - 1.000001, Math.log(frequency / lowest) / ratio * (GROUND_GRID_POINTS - 1));
  }
  const groundFrequencies = Float64Array.from({ length: GROUND_GRID_POINTS }, (_, index) => lowest * Math.exp(ratio * index / (GROUND_GRID_POINTS - 1)));
  return { preRoll, hop, size, bins, absorption, smoothing, smoothingLimit, gridPosition, groundFrequencies, binHz: sampleRate / size };
}

function absorptionLimit(plan, metres) {
  let low = 0;
  let high = plan.smoothingLimit;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (plan.absorption[middle] * metres > NEGLIGIBLE_NEPERS) high = middle; else low = middle + 1;
  }
  return low;
}

/**
 * Adds one path into a frame spectrum: source pulse × rise smoothing × 1/R × ISO 9613-1 absorption
 * × line-element directivity × ground reflection × e^(−iωτ) for the exact fractional offset τ.
 * Trigonometric terms advance by rotation from bin to bin.
 */
function accumulatePath(spectra, gains, plan, source, paths, index, offsetSamples, scene, speed, groundRe, groundIm, seed, receiverHeight) {
  const channels = spectra.length;
  const metres = paths.metres[index];
  const limit = absorptionLimit(plan, metres);
  if (limit < 2) return;
  const { absorption, smoothing, gridPosition, binHz, size } = plan;
  const gain = source.amplitudePaMetres * paths.amplitudeScale[index] / Math.max(metres, Number.MIN_VALUE);
  const ground = paths.kind[index] === PATH_GROUND && scene.ground.type !== 'rigid';
  const reflected = paths.kind[index] === PATH_GROUND;
  const turbulent = reflected && scene.air.turbulenceStrength > 0;
  if (ground || turbulent) {
    const random = createRandom(seed);
    const knots = Float64Array.from({ length: TURBULENCE_KNOTS }, () => normalDeviate(random));
    for (let point = 0; point < GROUND_GRID_POINTS; point += 1) {
      const frequency = plan.groundFrequencies[point];
      const q = ground ? sphericalReflectionCoefficient(frequency, scene.ground.type, paths.cosIncidence[index], metres, speed) : [1, 0];
      const position = point / (GROUND_GRID_POINTS - 1) * (TURBULENCE_KNOTS - 1);
      const lower = Math.min(TURBULENCE_KNOTS - 2, Math.floor(position));
      const deviate = knots[lower] + (knots[lower + 1] - knots[lower]) * (position - lower);
      const phase = turbulent ? deviate * Math.sqrt(turbulentPhaseVariance(frequency, metres, source.positionMetres.z, receiverHeight, scene.air, speed)) : 0;
      groundRe[point] = q[0] * Math.cos(phase) - q[1] * Math.sin(phase);
      groundIm[point] = q[0] * Math.sin(phase) + q[1] * Math.cos(phase);
    }
  }
  const phaseStep = -2 * Math.PI * offsetSamples / size;
  const phaseStepRe = Math.cos(phaseStep);
  const phaseStepIm = Math.sin(phaseStep);
  let phaseRe = phaseStepRe;
  let phaseIm = phaseStepIm;

  const directivityStep = Math.PI * binHz * source.elementMetres * paths.directivityCos[index] / speed;
  const directive = source.elementMetres > 0 && Math.abs(directivityStep) > 1e-12;
  const directivityStepRe = Math.cos(directivityStep);
  const directivityStepIm = Math.sin(directivityStep);
  let directivityRe = directivityStepRe;
  let directivityIm = directivityStepIm;

  const omegaStep = 2 * Math.PI * binHz;
  const nWave = source.pulse === 'n-wave';
  const duration = paths.duration[index];
  const pulseStep = omegaStep * duration;
  const pulseStepRe = Math.cos(pulseStep);
  const pulseStepIm = Math.sin(pulseStep);
  let pulseCos = pulseStepRe;
  let pulseSin = pulseStepIm;
  const friedlanderRe = source.decay / duration;

  for (let bin = 1; bin < limit; bin += 1) {
    const omega = omegaStep * bin;
    let re;
    let im;
    if (nWave) {
      const x = pulseStep * bin;
      if (x < SMALL_ARGUMENT) {
        re = 0;
        im = omega * duration * duration / 6;
      } else {
        const scale = 2 / (duration * omega * omega);
        re = pulseSin / omega + scale * (1 - pulseCos - x * pulseSin);
        im = (pulseCos - 1) / omega + scale * (pulseSin - x * pulseCos);
      }
      const nextCos = pulseCos * pulseStepRe - pulseSin * pulseStepIm;
      pulseSin = pulseCos * pulseStepIm + pulseSin * pulseStepRe;
      pulseCos = nextCos;
    } else {
      const sScale = friedlanderRe * friedlanderRe + omega * omega;
      const inverseRe = friedlanderRe / sScale;
      const inverseIm = -omega / sScale;
      re = inverseRe - (inverseRe * inverseRe - inverseIm * inverseIm) / duration;
      im = inverseIm - 2 * inverseRe * inverseIm / duration;
    }
    let factor = gain * smoothing[bin] * Math.exp(-absorption[bin] * metres);
    if (directive) {
      factor *= directivityIm / (directivityStep * bin);
      const nextRe = directivityRe * directivityStepRe - directivityIm * directivityStepIm;
      directivityIm = directivityRe * directivityStepIm + directivityIm * directivityStepRe;
      directivityRe = nextRe;
    }
    re *= factor;
    im *= factor;
    if (ground || turbulent) {
      const position = gridPosition[bin];
      const lower = Math.floor(position);
      const mix = position - lower;
      const qRe = groundRe[lower] + (groundRe[lower + 1] - groundRe[lower]) * mix;
      const qIm = groundIm[lower] + (groundIm[lower + 1] - groundIm[lower]) * mix;
      const nextRe = re * qRe - im * qIm;
      im = re * qIm + im * qRe;
      re = nextRe;
    }
    const outRe = re * phaseRe - im * phaseIm;
    const outIm = re * phaseIm + im * phaseRe;
    for (let channel = 0; channel < channels; channel += 1) {
      spectra[channel].real[bin] += gains[channel] * outRe;
      spectra[channel].imaginary[bin] += gains[channel] * outIm;
    }
    const nextPhaseRe = phaseRe * phaseStepRe - phaseIm * phaseStepIm;
    phaseIm = phaseRe * phaseStepIm + phaseIm * phaseStepRe;
    phaseRe = nextPhaseRe;
  }
}

/** Inverse transform of a continuous-time spectrum sampled at bins: x[n] = fs · IDFT(X). */
function synthesizeFrame(real, imaginary, size, sampleRate) {
  for (let bin = 1; bin < size / 2; bin += 1) {
    real[size - bin] = real[bin];
    imaginary[size - bin] = -imaginary[bin];
  }
  real[0] = 0;
  imaginary[0] = 0;
  imaginary[size / 2] = 0;
  fft(real, imaginary, true);
  for (let index = 0; index < size; index += 1) real[index] *= sampleRate;
  return real;
}

/**
 * Renders the pressure contribution of the paths whose arrival lies in [fromSeconds, toSeconds)
 * at one receiver: p_r(t) = Σ (s_i * h_i,r)(t). Paths are gathered into overlapping frames of 2H
 * samples at hop H; each frame is one inverse FFT, overlap-added in Float64. Time zero is the
 * scene's emission origin. Returns the segment's first sample index and its samples.
 */
export function renderReceiverRange(preparedEmitters, receiver, scene, { fromSeconds = -Infinity, toSeconds = Infinity, onProgress = null } = {}) {
  const sampleRate = scene.render.sampleRate;
  const speed = speedOfSoundMetresPerSecond(scene.air.temperatureCelsius);
  const paths = receiverPaths(preparedEmitters, receiver, scene);
  const plans = preparedEmitters.map((prepared, emitterIndex) => framePlan(prepared, emitterIndex, paths, sampleRate, speed, scene));
  const selected = [];
  for (let index = 0; index < paths.count; index += 1) {
    if (paths.seconds[index] >= fromSeconds && paths.seconds[index] < toSeconds) selected.push(index);
  }
  const frameOf = new Float64Array(paths.count);
  let first = Infinity;
  let last = -Infinity;
  let nonlinearPaths = 0;
  for (const index of selected) {
    const plan = plans[paths.emitter[index]];
    const frame = Math.floor((paths.seconds[index] * sampleRate - plan.preRoll) / plan.hop);
    frameOf[index] = frame;
    first = Math.min(first, frame * plan.hop);
    last = Math.max(last, frame * plan.hop + plan.size);
    const source = preparedEmitters[paths.emitter[index]].sources[paths.source[index]];
    if (paths.metres[index] < source.linearRadiusMetres) nonlinearPaths += 1;
  }
  const order = scene.render.ambisonicOrder;
  const channels = channelCount(order);
  if (!selected.length) return { startSample: 0, channels: Array.from({ length: channels }, () => new Float64Array(0)), nonlinearPaths: 0, pathCount: 0 };
  if ((last - first) / sampleRate > MAXIMUM_RENDER_SECONDS) {
    throw new RangeError(`Arrivals at ${receiver.name} span ${((last - first) / sampleRate).toFixed(1)} s; the limit is ${MAXIMUM_RENDER_SECONDS} s.`);
  }
  const outputs = Array.from({ length: channels }, () => new Float64Array(last - first));
  const gains = new Float64Array(channels);
  selected.sort((a, b) => paths.emitter[a] - paths.emitter[b] || frameOf[a] - frameOf[b] || a - b);
  const groundRe = new Float64Array(GROUND_GRID_POINTS);
  const groundIm = new Float64Array(GROUND_GRID_POINTS);
  let cursor = 0;
  while (cursor < selected.length) {
    const emitterIndex = paths.emitter[selected[cursor]];
    const frame = frameOf[selected[cursor]];
    const plan = plans[emitterIndex];
    const spectra = Array.from({ length: channels }, () => ({ real: new Float64Array(plan.size), imaginary: new Float64Array(plan.size) }));
    while (cursor < selected.length && paths.emitter[selected[cursor]] === emitterIndex && frameOf[selected[cursor]] === frame) {
      const index = selected[cursor];
      const source = preparedEmitters[emitterIndex].sources[paths.source[index]];
      const seed = (Math.imul(preparedEmitters[emitterIndex].emitter.seed ^ 0x9e3779b9, 31) + paths.source[index]) >>> 0;
      encodeDirection(paths.direction[3 * index], paths.direction[3 * index + 1], paths.direction[3 * index + 2], order, gains);
      accumulatePath(spectra, gains, plan, source, paths, index, paths.seconds[index] * sampleRate - frame * plan.hop, scene, speed, groundRe, groundIm, seed, receiver.positionMetres.z);
      cursor += 1;
    }
    const at = frame * plan.hop - first;
    spectra.forEach(({ real, imaginary }, channel) => {
      const block = synthesizeFrame(real, imaginary, plan.size, sampleRate);
      const output = outputs[channel];
      for (let sample = 0; sample < plan.size; sample += 1) output[at + sample] += block[sample];
    });
    onProgress?.(cursor, selected.length);
  }
  return { startSample: first, channels: outputs, nonlinearPaths, pathCount: selected.length };
}

/**
 * Sums rendered segments in the given order into Float32 channels, checking every sample. Channel 0
 * is the omnidirectional pressure W. Returns the channels, their start time, and the peak of W in
 * pascals.
 */
export function combineSegments(segments, sampleRate) {
  const present = segments.filter(segment => segment.channels[0].length);
  const count = segments[0]?.channels.length ?? 1;
  if (!present.length) return { startSeconds: 0, channels: Array.from({ length: count }, () => new Float32Array(0)), peakPa: 0 };
  const start = Math.min(...present.map(segment => segment.startSample));
  const end = Math.max(...present.map(segment => segment.startSample + segment.channels[0].length));
  if ((end - start) / sampleRate > MAXIMUM_RENDER_SECONDS) throw new RangeError(`The arrivals span ${((end - start) / sampleRate).toFixed(1)} s; the limit is ${MAXIMUM_RENDER_SECONDS} s.`);
  let peakPa = 0;
  const channels = Array.from({ length: count }, (_, channel) => {
    const sum = new Float64Array(end - start);
    for (const segment of present) {
      const offset = segment.startSample - start;
      const samples = segment.channels[channel];
      for (let index = 0; index < samples.length; index += 1) sum[offset + index] += samples[index];
    }
    const result = new Float32Array(sum.length);
    for (let index = 0; index < sum.length; index += 1) {
      if (!Number.isFinite(sum[index])) throw new RangeError('The render produced a non-finite sample.');
      result[index] = sum[index];
      if (channel === 0) peakPa = Math.max(peakPa, Math.abs(sum[index]));
    }
    return result;
  });
  return { startSeconds: start / sampleRate, channels, peakPa };
}

/** Time boundaries that split all arrivals at every receiver into `count` parts of equal size. */
export function partitionSeconds(preparedEmitters, scene, count) {
  const times = [];
  for (const receiver of scene.receivers) {
    const paths = receiverPaths(preparedEmitters, receiver, scene);
    for (let index = 0; index < paths.count; index += 1) times.push(paths.seconds[index]);
  }
  times.sort((a, b) => a - b);
  const boundaries = [-Infinity];
  for (let part = 1; part < count; part += 1) boundaries.push(times[Math.floor(part / count * times.length)] ?? Infinity);
  boundaries.push(Infinity);
  return boundaries;
}

/** The complete render at one receiver, in one thread. */
export function renderReceiver(preparedEmitters, receiver, scene) {
  const segment = renderReceiverRange(preparedEmitters, receiver, scene);
  const combined = combineSegments([segment], scene.render.sampleRate);
  return {
    receiverId: receiver.id,
    sampleRate: scene.render.sampleRate,
    ...combined,
    samples: combined.channels[0],
    speedOfSound: speedOfSoundMetresPerSecond(scene.air.temperatureCelsius),
    arrivals: arrivalTable(preparedEmitters, receiver, scene),
    nonlinearPaths: segment.nonlinearPaths,
    modelVersion: MODEL_VERSION
  };
}
