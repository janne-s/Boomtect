import { GROUND } from './constants.js';
import { cubeRootExponent } from './creeping.js';
import { fft, nextPowerOfTwo } from './fft.js';
import { createRandom, normalDeviate } from './random.js';

/**
 * A forest around the scene, at most tree height above the ground: it attenuates the sound that
 * passes under its canopy and leaves a reverberant tail at the receiver.
 */

const FOLIAGE_SCALE = GROUND.foliageDecibelsPerCubeRootHertz * Math.LN10 / 20 / (Math.cbrt(2 * Math.PI) * Math.cos(Math.PI / 6));

/** Foliage loss and phase lag per metre of path at a frequency, nepers and radians. */
export function foliageExponent(frequencyHz) {
  const [loss, lag] = cubeRootExponent(frequencyHz, GROUND.foliageCutoffHz);
  return [FOLIAGE_SCALE * loss, FOLIAGE_SCALE * lag];
}

/**
 * The length of a straight path of `metres` between heights `a` and `b` above the ground that runs
 * under the canopy (class C: ISO 9613-2 bends the path down on a 5 km arc; the ground is taken level).
 */
export function foliageMetres(metres, a, b, treeHeightMetres) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  if (high <= treeHeightMetres) return metres;
  if (low >= treeHeightMetres) return 0;
  return metres * (treeHeightMetres - low) / (high - low);
}

/** Length of the impulse response: the longest band has fallen 70 dB. */
export const REVERB_LENGTH_SECONDS = 70 / 60 * Math.max(...GROUND.forest.seconds);

const FOREST = Object.freeze({ ...GROUND.forest, salt: 0 });

/** The rumble of the surroundings over level ground, which over loaded terrain its echoes trace instead (GROUND.surroundings). */
const SURROUNDINGS = Object.freeze({ ...GROUND.surroundings, salt: 0x5bd1e995 });
/** Length of the surroundings' response: its longest band has fallen 70 dB. */
export const SURROUNDINGS_LENGTH_SECONDS = 70 / 60 * Math.max(...SURROUNDINGS.seconds);

/** A 32-bit seed from a receiver's id, so that each receiver hears its own forest. */
export function forestSeed(id) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}

/**
 * Impulse responses of the forest's tail for each Ambisonic channel, without the direct sound. Each
 * channel is its own seeded Gaussian noise, split into octave bands by raised-cosine crossovers in
 * log frequency, each band decaying with its time and scaled so that its energy is its share of a
 * unit impulse's energy in that band. The tail is diffuse: a channel of order n carries 1/(2n + 1)
 * of the omnidirectional energy (SN3D). Deterministic from the seed.
 */
export function forestResponses(seed, channels, sampleRate) {
  return cachedResponses(FOREST, seed, channels, sampleRate);
}

/** The surroundings' tail at a receiver (see SURROUNDINGS), per channel, from its own seed. */
export function surroundingsResponses(seed, channels, sampleRate) {
  return cachedResponses(SURROUNDINGS, (seed ^ SURROUNDINGS.salt) >>> 0, channels, sampleRate);
}

// A thread renders several ranges of one receiver in turn; they share the last responses made.
const lastResponses = new Map();

function cachedResponses(profile, seed, channels, sampleRate) {
  const key = `${seed}:${channels}:${sampleRate}`;
  if (lastResponses.get(profile)?.key !== key) lastResponses.set(profile, { key, responses: makeResponses(profile, seed, channels, sampleRate) });
  return lastResponses.get(profile).responses;
}

function makeResponses(profile, seed, channels, sampleRate) {
  const length = Math.ceil(70 / 60 * Math.max(...profile.seconds) * sampleRate);
  const size = nextPowerOfTwo(length);
  const binHz = sampleRate / size;
  const bands = GROUND.reverbBandsHz.length;
  // Crossover weights per bin; their squares sum to one, so the bands split the noise's energy.
  const weights = GROUND.reverbBandsHz.map(() => new Float64Array(size / 2 + 1));
  for (let bin = 1; bin <= size / 2; bin += 1) {
    const position = Math.log2(bin * binHz / GROUND.reverbBandsHz[0]);
    if (position <= 0) { weights[0][bin] = 1; continue; }
    if (position >= bands - 1) { weights[bands - 1][bin] = 1; continue; }
    const lower = Math.floor(position);
    const mix = position - lower;
    weights[lower][bin] = Math.cos(Math.PI / 2 * mix);
    weights[lower + 1][bin] = Math.sin(Math.PI / 2 * mix);
  }
  return Array.from({ length: channels }, (_, channel) => {
    const random = createRandom((seed + Math.imul(channel + 1, 0x9e3779b9)) >>> 0);
    const noiseRe = new Float64Array(size);
    const noiseIm = new Float64Array(size);
    for (let index = 0; index < length; index += 1) noiseRe[index] = normalDeviate(random);
    fft(noiseRe, noiseIm);
    const order = Math.floor(Math.sqrt(channel));
    const response = new Float64Array(length);
    for (let band = 0; band < bands; band += 1) {
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      let bandEnergy = 0;
      for (let bin = 1; bin <= size / 2; bin += 1) {
        const weight = weights[band][bin];
        if (!weight) continue;
        re[bin] = noiseRe[bin] * weight; im[bin] = noiseIm[bin] * weight;
        if (bin < size / 2) { re[size - bin] = re[bin]; im[size - bin] = -im[bin]; }
        bandEnergy += weight * weight;
      }
      if (!bandEnergy) continue;
      fft(re, im, true);
      const decay = 3 * Math.LN10 / profile.seconds[band];
      let energy = 0;
      for (let index = 0; index < length; index += 1) {
        const t = index / sampleRate;
        re[index] *= (1 - Math.exp(-t / profile.buildSeconds)) * Math.exp(-decay * t);
        energy += re[index] * re[index];
      }
      // A unit impulse carries bandEnergy / (size / 2) of its energy in this band.
      const target = profile.energyShare * profile.seconds[band] / profile.seconds[5] * bandEnergy / (size / 2) / (2 * order + 1);
      const scale = energy > 0 ? Math.sqrt(target / energy) : 0;
      for (let index = 0; index < length; index += 1) response[index] += re[index] * scale;
    }
    return response;
  });
}

/**
 * Adds a diffuse tail (the forest's or the surroundings') to rendered channels in place: every channel gains the omnidirectional
 * pressure convolved with its own response. The channels must already hold room for the tail.
 */
export function addForestTail(outputs, responses) {
  const length = outputs[0].length;
  const size = nextPowerOfTwo(length + responses[0].length);
  const sourceRe = new Float64Array(size);
  const sourceIm = new Float64Array(size);
  sourceRe.set(outputs[0]);
  fft(sourceRe, sourceIm);
  outputs.forEach((output, channel) => {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    re.set(responses[channel]);
    fft(re, im);
    for (let bin = 0; bin < size; bin += 1) {
      const productRe = re[bin] * sourceRe[bin] - im[bin] * sourceIm[bin];
      im[bin] = re[bin] * sourceIm[bin] + im[bin] * sourceRe[bin];
      re[bin] = productRe;
    }
    fft(re, im, true);
    for (let index = 0; index < length; index += 1) output[index] += re[index];
  });
}
