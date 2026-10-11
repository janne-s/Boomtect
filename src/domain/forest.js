import { GROUND } from './constants.js';
import { cubeRootExponent } from './creeping.js';
import { fft, nextPowerOfTwo, overlapSize, silent } from './fft.js';
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
 * of the omnidirectional energy (SN3D). Deterministic from the seed. Each channel is made on its own,
 * so `[first, last)` makes a share of them.
 */
export function forestResponses(seed, channels, sampleRate, [first, last] = [0, channels]) {
  return cachedResponses(FOREST, seed, sampleRate, first, last);
}

/** The surroundings' tail at a receiver (see SURROUNDINGS), per channel, from its own seed. */
export function surroundingsResponses(seed, channels, sampleRate, [first, last] = [0, channels]) {
  return cachedResponses(SURROUNDINGS, (seed ^ SURROUNDINGS.salt) >>> 0, sampleRate, first, last);
}

// A thread renders several ranges of one receiver in turn; they share the last responses made.
const lastResponses = new Map();

function cachedResponses(profile, seed, sampleRate, first, last) {
  const key = `${seed}:${first}:${last}:${sampleRate}`;
  if (lastResponses.get(profile)?.key !== key) lastResponses.set(profile, { key, responses: makeResponses(profile, seed, sampleRate, first, last) });
  return lastResponses.get(profile).responses;
}

function makeResponses(profile, seed, sampleRate, first, last) {
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
  return Array.from({ length: last - first }, (_, share) => {
    const channel = first + share;
    const random = createRandom((seed + Math.imul(channel + 1, 0x9e3779b9)) >>> 0);
    const noiseRe = new Float64Array(size);
    const noiseIm = new Float64Array(size);
    for (let index = 0; index < length; index += 1) noiseRe[index] = normalDeviate(random);
    fft(noiseRe, noiseIm);
    const order = Math.floor(Math.sqrt(channel));
    const response = new Float64Array(length);
    // Two bands share each inverse transform: one as the real part of the signal, the other as the imaginary.
    for (let band = 0; band < bands; band += 2) {
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      const energies = [0, 0];
      for (let part = 0; part < 2 && band + part < bands; part += 1) {
        const weightsOf = weights[band + part];
        // The band's Hermitian spectrum enters times 1 or times i.
        for (let bin = 1; bin <= size / 2; bin += 1) {
          const weight = weightsOf[bin];
          if (!weight) continue;
          const bandRe = noiseRe[bin] * weight;
          const bandIm = noiseIm[bin] * weight;
          if (part === 0) {
            re[bin] += bandRe; im[bin] += bandIm;
            if (bin < size / 2) { re[size - bin] += bandRe; im[size - bin] -= bandIm; }
          } else {
            re[bin] -= bandIm; im[bin] += bandRe;
            if (bin < size / 2) { re[size - bin] += bandIm; im[size - bin] += bandRe; }
          }
          energies[part] += weight * weight;
        }
      }
      if (!energies[0] && !energies[1]) continue;
      fft(re, im, true);
      [re, im].forEach((signal, part) => {
        const bandEnergy = energies[part];
        if (!bandEnergy) return;
        const decay = 3 * Math.LN10 / profile.seconds[band + part];
        let energy = 0;
        for (let index = 0; index < length; index += 1) {
          const t = index / sampleRate;
          signal[index] *= (1 - Math.exp(-t / profile.buildSeconds)) * Math.exp(-decay * t);
          energy += signal[index] * signal[index];
        }
        // A unit impulse carries bandEnergy / (size / 2) of its energy in this band.
        const target = profile.energyShare * profile.seconds[band + part] / profile.seconds[5] * bandEnergy / (size / 2) / (2 * order + 1);
        const scale = energy > 0 ? Math.sqrt(target / energy) : 0;
        for (let index = 0; index < length; index += 1) response[index] += signal[index] * scale;
      });
    }
    return response;
  });
}

/**
 * Adds a diffuse tail (the forest's or the surroundings') to rendered channels in place: every channel gains the omnidirectional
 * pressure convolved with its own response. The pressure is channel 0 as it was, unless `source` gives it.
 * The channels must already hold room for the tail.
 *
 * The convolution is overlap-add in blocks a few responses long, rather than one transform of the
 * whole render, which for minutes of sound took seconds and hundreds of megabytes. Two channels share
 * each inverse transform: their responses enter as the real and imaginary parts of one signal, so the
 * product's real and imaginary parts are the two real convolutions.
 */
export function addForestTail(outputs, responses, source = outputs[0].slice()) {
  const length = outputs[0].length;
  const kernelLength = responses[0].length;
  if (!length || !kernelLength) return;
  const size = overlapSize(length, kernelLength);
  const block = size - kernelLength + 1;
  const pairs = [];
  for (let channel = 0; channel < outputs.length; channel += 2) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    re.set(responses[channel]);
    if (channel + 1 < outputs.length) im.set(responses[channel + 1]);
    fft(re, im);
    pairs.push({ channel, re, im });
  }
  const sourceRe = new Float64Array(size);
  const sourceIm = new Float64Array(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let start = 0; start < length; start += block) {
    // A render range's room for its tails is silent until the tails are added.
    if (silent(source, start, start + block)) continue;
    sourceRe.fill(0);
    sourceIm.fill(0);
    sourceRe.set(source.subarray(start, Math.min(length, start + block)));
    fft(sourceRe, sourceIm);
    const reach = Math.min(size, length - start);
    for (const pair of pairs) {
      for (let bin = 0; bin < size; bin += 1) {
        re[bin] = pair.re[bin] * sourceRe[bin] - pair.im[bin] * sourceIm[bin];
        im[bin] = pair.re[bin] * sourceIm[bin] + pair.im[bin] * sourceRe[bin];
      }
      fft(re, im, true);
      const first = outputs[pair.channel];
      const second = outputs[pair.channel + 1];
      for (let index = 0; index < reach; index += 1) first[start + index] += re[index];
      if (second) for (let index = 0; index < reach; index += 1) second[start + index] += im[index];
    }
  }
}

/**
 * The diffuse tails that a stretch of omnidirectional pressure leaves in every channel, from the
 * stretch's first sample to the end of its tails: the forest's tail of the pressure, then the
 * surroundings' tail of the pressure with the forest's tail, as the sound reaches them in turn.
 * Linear in the pressure, so the tails of consecutive stretches sum to the tails of the whole.
 */
export function diffuseTails(pressure, { forest = null, surroundings = null }, channels) {
  const length = pressure.length + (forest?.[0].length ?? 0) + (surroundings?.[0].length ?? 0);
  const tails = Array.from({ length: channels }, () => new Float64Array(length));
  const source = new Float64Array(length);
  source.set(pressure);
  if (forest) addForestTail(tails, forest, source);
  if (surroundings) {
    if (forest) for (let index = 0; index < length; index += 1) source[index] += tails[0][index];
    addForestTail(tails, surroundings, source);
  }
  return tails;
}
