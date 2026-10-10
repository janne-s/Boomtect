import { cubeRootExponent } from './creeping.js';
import { fft, nextPowerOfTwo } from './fft.js';
import { createRandom, normalDeviate } from './random.js';

/**
 * A forest around the scene, at most tree height above the ground: it attenuates the sound that
 * passes under its canopy and leaves a reverberant tail at the receiver.
 */

/**
 * Class B: ISO 9613-2:1996, Table A.1, attenuation through dense foliage per metre of path, octave
 * bands 63 Hz–8 kHz, for 20–200 m of foliage; beyond 200 m the 200 m value holds. ISO 9613-2
 * excludes blast waves, which holds here once the blast is linear.
 */
export const FOLIAGE_BANDS_HZ = Object.freeze([63, 125, 250, 500, 1000, 2000, 4000, 8000]);
export const FOLIAGE_DECIBELS_PER_METRE = Object.freeze([.02, .03, .04, .05, .06, .08, .09, .12]);
export const MAXIMUM_FOLIAGE_METRES = 200;
/**
 * The table follows 0.006·f^(1/3) dB/m within 0.006 dB/m in every band, the frequency law of Hoover's
 * forest formula, 0.01·f^(1/3) dB/m. As s·(s + ω_c)^(−2/3) it has the phase lag that keeps it causal
 * (as the creeping wave in `render.js`); well below the cutoff it becomes a delay (class C).
 */
const FOLIAGE_DECIBELS_PER_CUBE_ROOT_HERTZ = .006;
const FOLIAGE_CUTOFF_HZ = 10;
const FOLIAGE_SCALE = FOLIAGE_DECIBELS_PER_CUBE_ROOT_HERTZ * Math.LN10 / 20 / (Math.cbrt(2 * Math.PI) * Math.cos(Math.PI / 6));

/** Foliage loss and phase lag per metre of path at a frequency, nepers and radians. */
export function foliageExponent(frequencyHz) {
  const [loss, lag] = cubeRootExponent(frequencyHz, FOLIAGE_CUTOFF_HZ);
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

/**
 * Reverberation of the forest around the receiver, per octave band 31.5 Hz–16 kHz. Class B at 1 kHz:
 * T30 of 1.3–1.7 s in snowy forest at Koli National Park (Shelley, Murphy & Chadwick, DAFx 2013),
 * where most of the reverberant energy lies at 1 kHz and the low bands are dry. The other bands'
 * times are shaped around it (class C).
 */
const REVERB_BANDS_HZ = Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
const REVERB_SECONDS = Object.freeze([.2, .3, .5, .8, 1.15, 1.5, 1.3, 1, .7, .5]);
/**
 * Energy of the tail against the energy of the sound that excites it, at 1 kHz; other bands scale
 * with their reverberation time. Class C: the Koli clarity C50 was high, so the tail is well below
 * the direct sound near the source.
 */
const REVERB_ENERGY_SHARE = .1;
/** The tail builds up from the nearest trunks over a few milliseconds (class C). */
const REVERB_BUILD_SECONDS = .005;
/** Length of the impulse response: the longest band has fallen 70 dB. */
export const REVERB_LENGTH_SECONDS = 70 / 60 * Math.max(...REVERB_SECONDS);

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
  // A thread renders several ranges of one receiver in turn; they share the last responses made.
  const key = `${seed}:${channels}:${sampleRate}`;
  if (lastResponses?.key !== key) lastResponses = { key, responses: makeResponses(seed, channels, sampleRate) };
  return lastResponses.responses;
}

let lastResponses = null;

function makeResponses(seed, channels, sampleRate) {
  const length = Math.ceil(REVERB_LENGTH_SECONDS * sampleRate);
  const size = nextPowerOfTwo(length);
  const binHz = sampleRate / size;
  const bands = REVERB_BANDS_HZ.length;
  // Crossover weights per bin; their squares sum to one, so the bands split the noise's energy.
  const weights = REVERB_BANDS_HZ.map(() => new Float64Array(size / 2 + 1));
  for (let bin = 1; bin <= size / 2; bin += 1) {
    const position = Math.log2(bin * binHz / REVERB_BANDS_HZ[0]);
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
      const decay = 3 * Math.LN10 / REVERB_SECONDS[band];
      let energy = 0;
      for (let index = 0; index < length; index += 1) {
        const t = index / sampleRate;
        re[index] *= (1 - Math.exp(-t / REVERB_BUILD_SECONDS)) * Math.exp(-decay * t);
        energy += re[index] * re[index];
      }
      // A unit impulse carries bandEnergy / (size / 2) of its energy in this band.
      const target = REVERB_ENERGY_SHARE * REVERB_SECONDS[band] / REVERB_SECONDS[5] * bandEnergy / (size / 2) / (2 * order + 1);
      const scale = energy > 0 ? Math.sqrt(target / energy) : 0;
      for (let index = 0; index < length; index += 1) response[index] += re[index] * scale;
    }
    return response;
  });
}

/**
 * Adds the forest's tail to rendered channels in place: every channel gains the omnidirectional
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
