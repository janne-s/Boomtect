import { atmosphericAbsorptionNepersPerMetre, pressureAtHeightPa, temperatureAtHeightKelvin } from './air.js';
import { ambisonicDirection, channelCount, encodeDirection } from './ambisonics.js';
import { MAXIMUM_RENDER_SECONDS, MAXIMUM_SOURCES, MODEL_VERSION } from './constants.js';
import { emitterSources } from './emitters.js';
import { knifeEdge } from './diffraction.js';
import { sourcePosition, sourceTable } from './source-table.js';
import { onGround, terrainSurface } from './terrain.js';
import { shieldingEdges, shiftedProfile, terrainReflection } from './terrain-propagation.js';
import { fft, nextPowerOfTwo } from './fft.js';
import { sphericalReflectionCoefficient } from './ground.js';
import { weakShockPulse } from './lightning.js';
import { riseSmoothing } from './pulses.js';
import { createRandom, normalDeviate } from './random.js';
import {
  creepingCoefficient, inShadow, PATH_DIRECT, PATH_GROUND, PATH_SHADOW, rayBetween, reflectedRay, shadowPath, soundSpeedProfile, speedAt
} from './refraction.js';

/** Samples kept before each arrival for zero-phase smoothing, absorption, and directivity. */
const PRE_ROLL_SAMPLES = 512;
/** Terrain edges kept per path (Deygout's main edge and one on each side). */
const MAXIMUM_EDGES = 3;
/** Samples kept after each pulse for the ground-reflection response to settle. */
const TAIL_GUARD_SAMPLES = 2048;
/** Attenuation beyond which a bin no longer contributes: 14 Np ≈ 122 dB. */
const NEGLIGIBLE_NEPERS = 14;
const NEGLIGIBLE_SMOOTHING = 1e-7;
const GROUND_GRID_POINTS = 64;
/** Knots of the seeded turbulent phase curve across frequency; the grid interpolates between them. */
const TURBULENCE_KNOTS = 9;
const SMALL_ARGUMENT = 1e-4;
/** Frequency at which the arrival diagram weighs a shadow path's creeping loss. */
const DIAGRAM_FREQUENCY_HZ = 100;
/** Below this frequency the creeping response is regularized so that its tail decays within a frame. */
const SHADOW_REGULARIZATION_HZ = 5;

/**
 * Seconds until the shadow response for a creeping loss of `nepersAtOneHertz` has fallen 80 dB below
 * its peak: an upper bound measured on its impulse response for creeping distances of 0.2–60 km and
 * gradients of 2–12 K/km, t ≤ 0.1 + 0.6·β^0.65.
 */
export function shadowTailSeconds(nepersAtOneHertz) {
  if (!(nepersAtOneHertz > 0)) return 0;
  return .1 + .6 * creepingBeta(nepersAtOneHertz) ** .65;
}

/** Paths are framed per emitter, and separately for shadow paths, whose response needs a longer tail. */
const frameGroup = (paths, index) => 2 * paths.emitter[index] + (paths.creepMetres[index] > 0 ? 1 : 0);

export const MISSING_PHENOMENA = Object.freeze([
  'Echoes from terrain, buildings, and clouds',
  'Diffraction by buildings and rounded ridges',
  'Wind',
  'Turbulent scattering of the direct sound',
  'Nonlinear propagation beyond the linearization radius',
  'Absolute calibration of sound pressure level'
]);

/**
 * Expands every enabled emitter into point sources, kept as a typed table so that the flash
 * geometry behind them can be released. Pure and deterministic from the scene.
 */
export function prepareScene(scene) {
  const surface = terrainSurface(scene.terrain);
  const prepared = scene.emitters.filter(emitter => emitter.enabled).map(emitter => ({ emitter, sources: sourceTable(emitterSources(emitter, scene.air, surface).sources) }));
  const count = prepared.reduce((sum, item) => sum + item.sources.length, 0);
  if (count > MAXIMUM_SOURCES) throw new RangeError(`The scene has ${count} point sources; the limit is ${MAXIMUM_SOURCES}.`);
  return prepared;
}

/**
 * Class A: a receiver above the ground hears a pulse defined in ground-level air scaled by
 * sqrt(ρc at the receiver / ρc at the ground), from the energy flux along a ray tube. Source levels
 * are stated for ground-level air, so this is 1 at the ground and in homogeneous air.
 */
function receiverImpedanceFactor(air, profile, heightMetres) {
  if (!air.refraction) return 1;
  const density = pressureAtHeightPa(air, heightMetres) / pressureAtHeightPa(air, 0) * temperatureAtHeightKelvin(air, 0) / temperatureAtHeightKelvin(air, heightMetres);
  return Math.sqrt(density * speedAt(profile, heightMetres) / profile.groundSpeed);
}

/**
 * Every path from the prepared sources to one receiver, as parallel typed arrays: the direct ray,
 * or in the refraction shadow the creeping path, and the ground-reflected ray where one exists.
 * Order is emitter, source, then direct before ground, so it is deterministic. `metres` is the
 * length along the path, which absorption and the weak shock use; `spreadMetres` the distance
 * whose inverse is the geometric amplitude; `edges` the geometric factors of the terrain edges
 * that shield a direct path (see `diffraction.js`).
 *
 * Over terrain, the refraction shadow and the ground reflection are found from the ground under the
 * receiver, as if the ground there extended level; the shielding checks the actual terrain.
 */
export function receiverPaths(preparedEmitters, receiver, scene) {
  const profile = soundSpeedProfile(scene.air);
  const ground = scene.ground.enabled;
  const capacity = preparedEmitters.reduce((sum, item) => sum + item.sources.length, 0) * (ground ? 2 : 1);
  const paths = {
    count: 0,
    emitter: new Uint16Array(capacity),
    source: new Uint32Array(capacity),
    kind: new Uint8Array(capacity),
    seconds: new Float64Array(capacity),
    metres: new Float64Array(capacity),
    spreadMetres: new Float64Array(capacity),
    creepMetres: new Float64Array(capacity),
    directivityCos: new Float64Array(capacity),
    cosIncidence: new Float64Array(capacity),
    duration: new Float64Array(capacity),
    amplitudeScale: new Float64Array(capacity),
    direction: new Float64Array(3 * capacity),
    edgeCount: new Uint8Array(capacity),
    edges: new Float64Array(MAXIMUM_EDGES * capacity)
  };
  const surface = terrainSurface(scene.terrain);
  const shielding = !surface.flat && scene.terrain.shielding;
  const receiverPosition = onGround(surface, receiver.positionMetres);
  const groundHeight = surface.heightAt(receiverPosition.x, receiverPosition.y);
  const local = shiftedProfile(profile, groundHeight);
  const shift = point => (groundHeight === 0 ? point : { x: point.x, y: point.y, z: point.z - groundHeight });
  const r = shift(receiverPosition);
  const impedance = receiverImpedanceFactor(scene.air, profile, receiverPosition.z);
  let index = 0;
  const add = (emitterIndex, sourceIndex, sources, kind, path, edges = []) => {
    const { departure, arrival } = path;
    paths.edgeCount[index] = edges.length;
    edges.forEach((edge, edgeIndex) => { paths.edges[MAXIMUM_EDGES * index + edgeIndex] = edge; });
    paths.emitter[index] = emitterIndex;
    paths.source[index] = sourceIndex;
    paths.kind[index] = kind;
    paths.metres[index] = path.metres;
    paths.spreadMetres[index] = path.spreadMetres / impedance;
    paths.creepMetres[index] = path.creepMetres ?? 0;
    paths.seconds[index] = sources.emissionSeconds[sourceIndex] + path.seconds;
    // The element's phase spread uses the local wavelength, so its directivity cosine carries c₀/c.
    paths.directivityCos[index] = sources.directed[sourceIndex]
      ? (sources.dx[sourceIndex] * departure.x + sources.dy[sourceIndex] * departure.y + sources.dz[sourceIndex] * departure.z) * profile.groundSpeed / speedAt(profile, sources.z[sourceIndex])
      : 0;
    paths.cosIncidence[index] = path.groundSine ?? 1;
    paths.direction.set(path.metres > 0 ? ambisonicDirection(-arrival.x, -arrival.y, -arrival.z) : [1, 0, 0], 3 * index);
    if (sources.relaxationRadius[sourceIndex] > 0) {
      const pulse = weakShockPulse(sources.relaxationRadius[sourceIndex], sources.sourcePeriodSeconds[sourceIndex], path.metres, sources.limitRadii[sourceIndex]);
      paths.duration[index] = pulse.durationSeconds;
      paths.amplitudeScale[index] = pulse.amplitudeScale;
    } else {
      paths.duration[index] = sources.durationSeconds[sourceIndex];
      paths.amplitudeScale[index] = 1;
    }
    index += 1;
  };
  preparedEmitters.forEach((prepared, emitterIndex) => {
    const { sources } = prepared;
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      const position = sourcePosition(sources, sourceIndex);
      const p = shift(position);
      if (inShadow(local, p, r)) {
        add(emitterIndex, sourceIndex, sources, PATH_SHADOW, shadowPath(local, p, r));
        continue;
      }
      const edges = shielding ? shieldingEdges(profile, surface, position, receiverPosition) : [];
      add(emitterIndex, sourceIndex, sources, PATH_DIRECT, rayBetween(local, p, r), edges);
      if (!ground) continue;
      // The reflection near the receiver crosses the same ridges as the direct sound (class C).
      const reflected = surface.flat ? reflectedRay(profile, p, r) : terrainReflection(profile, surface, position, receiverPosition);
      if (reflected) add(emitterIndex, sourceIndex, sources, PATH_GROUND, reflected, edges);
    }
  });
  paths.count = index;
  return paths;
}

/** The level change of a path's terrain edges at one frequency, in decibels. */
function edgeDecibels(paths, index, frequencyHz) {
  let decibels = 0;
  for (let edge = 0; edge < paths.edgeCount[index]; edge += 1) {
    decibels += 20 * Math.log10(Math.hypot(...knifeEdge(paths.edges[MAXIMUM_EDGES * index + edge] * Math.sqrt(frequencyHz))));
  }
  return decibels;
}

/**
 * Arrival time, source height, and geometric level of every path, for the arrival diagram; a
 * shadow path's level includes its creeping loss at DIAGRAM_FREQUENCY_HZ.
 */
export function arrivalTable(preparedEmitters, receiver, scene) {
  const paths = receiverPaths(preparedEmitters, receiver, scene);
  const heights = new Float32Array(paths.count);
  const levels = new Float32Array(paths.count);
  const creep = creepingCoefficient(soundSpeedProfile(scene.air));
  const floor = 10 ** (-scene.air.shadowFloorDecibels / 20);
  for (let index = 0; index < paths.count; index += 1) {
    const { sources } = preparedEmitters[paths.emitter[index]];
    heights[index] = sources.z[paths.source[index]];
    levels[index] = 20 * Math.log10(sources.amplitudePaMetres[paths.source[index]] * paths.amplitudeScale[index] / Math.max(paths.spreadMetres[index], 1e-3))
      + (paths.creepMetres[index] > 0 ? 20 * Math.log10(Math.hypot(...shadowResponse(DIAGRAM_FREQUENCY_HZ, creep * paths.creepMetres[index], floor))) : 0)
      + edgeDecibels(paths, index, DIAGRAM_FREQUENCY_HZ);
  }
  return { count: paths.count, seconds: paths.seconds.slice(0, paths.count), heights, levels, kinds: paths.kind.slice(0, paths.count) };
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
 * Frame layout of one frame group at one receiver: hop H and block 2H hold any of its paths with
 * pre-roll and tail. It depends on all of the group's paths, so every time range shares it.
 */
function framePlan(prepared, group, paths, sampleRate, profile, scene) {
  const speed = profile.groundSpeed;
  const creeping = creepingCoefficient(profile);
  let longestElement = 0;
  let longestSpan = 0;
  let longestCreep = 0;
  const { sources } = prepared;
  for (let index = 0; index < sources.length; index += 1) longestElement = Math.max(longestElement, sources.elementMetres[index]);
  for (let index = 0; index < paths.count; index += 1) {
    if (frameGroup(paths, index) !== group) continue;
    const source = paths.source[index];
    longestSpan = Math.max(longestSpan, sources.relaxationRadius[source] > 0 ? paths.duration[index] : sources.spanSeconds[source]);
    longestCreep = Math.max(longestCreep, paths.creepMetres[index]);
  }
  const preRoll = PRE_ROLL_SAMPLES + Math.ceil(longestElement / speed * sampleRate / 2);
  const shadowTail = Math.ceil(shadowTailSeconds(creeping * longestCreep) * sampleRate);
  const hop = nextPowerOfTwo(preRoll + Math.ceil(longestSpan * sampleRate) + TAIL_GUARD_SAMPLES + shadowTail);
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
  const shadowFloor = 10 ** (-scene.air.shadowFloorDecibels / 20);
  const shadow = longestCreep > 0 ? { loss: new Float64Array(bins), lag: new Float64Array(bins) } : null;
  if (shadow) {
    for (let bin = 1; bin < bins; bin += 1) [shadow.loss[bin], shadow.lag[bin]] = shadowExponent(bin * sampleRate / size);
  }
  return { preRoll, hop, size, bins, absorption, creeping, shadow, shadowFloor, smoothing, smoothingLimit, gridPosition, groundFrequencies, binHz: sampleRate / size };
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
 * The shadow's transfer at one frequency, in the e^(+iωt) convention of `fft.js`. `nepersAtOneHertz`
 * is the creeping loss αL at 1 Hz, which grows as f^(1/3). The creeping mode's propagation constant
 * carries s^(1/3), s = iω, so its loss comes with a phase lag of 1/√3 of it: H = exp(−β·s^(1/3)) is
 * causal and delays the low frequencies (class B). Its impulse response has a t^(−4/3) tail, so
 * s^(1/3) becomes s·(s + ω_c)^(−2/3): a plain delay well below SHADOW_REGULARIZATION_HZ, a
 * loss 4.4 % short of the creeping law at 50 Hz, 2.1 % at 100 Hz, and 0.5 % at 400 Hz, and an
 * impulse response whose tail decays exponentially (class C).
 * The scattered share F of the shadow floor joins it smoothly, (1 − F)·H + F (class C).
 */
export function shadowResponse(frequencyHz, nepersAtOneHertz, floor) {
  const [loss, lag] = shadowExponent(frequencyHz);
  return shadowFromExponent(loss, lag, creepingBeta(nepersAtOneHertz), floor);
}

/** β of the creeping response from its loss at 1 Hz: α(1 Hz)·L = (√3/2)·β·(2π)^(1/3). */
const creepingBeta = nepersAtOneHertz => 2 * nepersAtOneHertz / (Math.sqrt(3) * Math.cbrt(2 * Math.PI));

/** Real and imaginary parts of s·(s + ω_c)^(−2/3) at s = iω, which depend on frequency alone. */
function shadowExponent(frequencyHz) {
  const omega = 2 * Math.PI * frequencyHz;
  const cutoff = 2 * Math.PI * SHADOW_REGULARIZATION_HZ;
  const size = omega * Math.hypot(cutoff, omega) ** (-2 / 3);
  const angle = Math.PI / 2 - 2 / 3 * Math.atan2(omega, cutoff);
  return [size * Math.cos(angle), size * Math.sin(angle)];
}

function shadowFromExponent(loss, lag, beta, floor) {
  const magnitude = (1 - floor) * Math.exp(-beta * loss);
  const phase = -beta * lag;
  return [magnitude * Math.cos(phase) + floor, magnitude * Math.sin(phase)];
}

/**
 * Adds one path into a frame spectrum: source pulse × rise smoothing × geometric spreading ×
 * ISO 9613-1 absorption along the path × line-element directivity × ground reflection × the
 * shadow response × e^(−iωτ) for the exact fractional offset τ. Trigonometric terms advance by rotation from bin to bin.
 */
function accumulatePath(spectra, gains, plan, sources, sourceIndex, paths, index, offsetSamples, scene, speed, groundRe, groundIm, seed, receiverHeight) {
  const channels = spectra.length;
  const metres = paths.metres[index];
  const limit = absorptionLimit(plan, metres);
  if (limit < 2) return;
  const { absorption, smoothing, gridPosition, binHz, size } = plan;
  const gain = sources.amplitudePaMetres[sourceIndex] * paths.amplitudeScale[index] / Math.max(paths.spreadMetres[index], Number.MIN_VALUE);
  if (!(gain > 0)) return;
  const creepMetres = paths.creepMetres[index];
  const { creeping, shadow, shadowFloor } = plan;
  const beta = creepMetres > 0 ? creepingBeta(creeping * creepMetres) : 0;
  const edgeCount = paths.edgeCount[index];
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
      const phase = turbulent ? deviate * Math.sqrt(turbulentPhaseVariance(frequency, metres, sources.z[sourceIndex], receiverHeight, scene.air, speed)) : 0;
      groundRe[point] = q[0] * Math.cos(phase) - q[1] * Math.sin(phase);
      groundIm[point] = q[0] * Math.sin(phase) + q[1] * Math.cos(phase);
    }
  }
  const phaseStep = -2 * Math.PI * offsetSamples / size;
  const phaseStepRe = Math.cos(phaseStep);
  const phaseStepIm = Math.sin(phaseStep);
  let phaseRe = phaseStepRe;
  let phaseIm = phaseStepIm;

  const elementMetres = sources.elementMetres[sourceIndex];
  const directivityStep = Math.PI * binHz * elementMetres * paths.directivityCos[index] / speed;
  const directive = elementMetres > 0 && Math.abs(directivityStep) > 1e-12;
  const directivityStepRe = Math.cos(directivityStep);
  const directivityStepIm = Math.sin(directivityStep);
  let directivityRe = directivityStepRe;
  let directivityIm = directivityStepIm;

  const omegaStep = 2 * Math.PI * binHz;
  const nWave = sources.friedlander[sourceIndex] === 0;
  const duration = paths.duration[index];
  const pulseStep = omegaStep * duration;
  const pulseStepRe = Math.cos(pulseStep);
  const pulseStepIm = Math.sin(pulseStep);
  let pulseCos = pulseStepRe;
  let pulseSin = pulseStepIm;
  const friedlanderRe = sources.decay[sourceIndex] / duration;

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
    for (let edge = 0; edge < edgeCount; edge += 1) {
      const [eRe, eIm] = knifeEdge(paths.edges[MAXIMUM_EDGES * index + edge] * Math.sqrt(bin * binHz));
      const nextRe = re * eRe - im * eIm;
      im = re * eIm + im * eRe;
      re = nextRe;
    }
    if (creepMetres > 0) {
      const [cRe, cIm] = shadowFromExponent(shadow.loss[bin], shadow.lag[bin], beta, shadowFloor);
      const nextRe = re * cRe - im * cIm;
      im = re * cIm + im * cRe;
      re = nextRe;
    }
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
  const profile = soundSpeedProfile(scene.air);
  const speed = profile.groundSpeed;
  const paths = receiverPaths(preparedEmitters, receiver, scene);
  const plans = preparedEmitters.flatMap((prepared, emitterIndex) => [0, 1].map(shadow => framePlan(prepared, 2 * emitterIndex + shadow, paths, sampleRate, profile, scene)));
  const selected = [];
  for (let index = 0; index < paths.count; index += 1) {
    if (paths.seconds[index] >= fromSeconds && paths.seconds[index] < toSeconds) selected.push(index);
  }
  const frameOf = new Float64Array(paths.count);
  let first = Infinity;
  let last = -Infinity;
  let nonlinearPaths = 0;
  for (const index of selected) {
    const plan = plans[frameGroup(paths, index)];
    const frame = Math.floor((paths.seconds[index] * sampleRate - plan.preRoll) / plan.hop);
    frameOf[index] = frame;
    first = Math.min(first, frame * plan.hop);
    last = Math.max(last, frame * plan.hop + plan.size);
    if (paths.metres[index] < preparedEmitters[paths.emitter[index]].sources.linearRadiusMetres[paths.source[index]]) nonlinearPaths += 1;
  }
  const order = scene.render.ambisonicOrder;
  const channels = channelCount(order);
  if (!selected.length) return { startSample: 0, channels: Array.from({ length: channels }, () => new Float64Array(0)), nonlinearPaths: 0, pathCount: 0 };
  if ((last - first) / sampleRate > MAXIMUM_RENDER_SECONDS) {
    throw new RangeError(`Arrivals at ${receiver.name} span ${((last - first) / sampleRate).toFixed(1)} s; the limit is ${MAXIMUM_RENDER_SECONDS} s.`);
  }
  const outputs = Array.from({ length: channels }, () => new Float64Array(last - first));
  const gains = new Float64Array(channels);
  selected.sort((a, b) => frameGroup(paths, a) - frameGroup(paths, b) || frameOf[a] - frameOf[b] || a - b);
  const groundRe = new Float64Array(GROUND_GRID_POINTS);
  const groundIm = new Float64Array(GROUND_GRID_POINTS);
  let cursor = 0;
  while (cursor < selected.length) {
    const group = frameGroup(paths, selected[cursor]);
    const emitterIndex = paths.emitter[selected[cursor]];
    const frame = frameOf[selected[cursor]];
    const plan = plans[group];
    const spectra = Array.from({ length: channels }, () => ({ real: new Float64Array(plan.size), imaginary: new Float64Array(plan.size) }));
    while (cursor < selected.length && frameGroup(paths, selected[cursor]) === group && frameOf[selected[cursor]] === frame) {
      const index = selected[cursor];
      const { sources } = preparedEmitters[emitterIndex];
      const seed = (Math.imul(preparedEmitters[emitterIndex].emitter.seed ^ 0x9e3779b9, 31) + paths.source[index]) >>> 0;
      encodeDirection(paths.direction[3 * index], paths.direction[3 * index + 1], paths.direction[3 * index + 2], order, gains);
      accumulatePath(spectra, gains, plan, sources, paths.source[index], paths, index, paths.seconds[index] * sampleRate - frame * plan.hop, scene, speed, groundRe, groundIm, seed, receiver.positionMetres.z);
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

/**
 * Time boundaries that split all arrivals at every receiver into `count` parts of equal size. Pass
 * the receivers' arrival tables when they exist, so that their paths are not traced again.
 */
export function partitionSeconds(preparedEmitters, scene, count, tables = scene.receivers.map(receiver => arrivalTable(preparedEmitters, receiver, scene))) {
  const times = new Float64Array(tables.reduce((sum, table) => sum + table.count, 0));
  let at = 0;
  for (const table of tables) { times.set(table.seconds, at); at += table.count; }
  times.sort();
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
    speedOfSound: soundSpeedProfile(scene.air).groundSpeed,
    arrivals: arrivalTable(preparedEmitters, receiver, scene),
    nonlinearPaths: segment.nonlinearPaths,
    modelVersion: MODEL_VERSION
  };
}
