import { GROUND } from './constants.js';
import { cubeRootExponent } from './creeping.js';
import { fft, nextPowerOfTwo, overlapSize, silent } from './fft.js';
import { createRandom, normalDeviate } from './random.js';

const FOLIAGE_SCALE = GROUND.foliageDecibelsPerCubeRootHertz * Math.LN10 / 20 / (Math.cbrt(2 * Math.PI) * Math.cos(Math.PI / 6));

export function foliageExponent(frequencyHz) {
  const [loss, lag] = cubeRootExponent(frequencyHz, GROUND.foliageCutoffHz);
  return [FOLIAGE_SCALE * loss, FOLIAGE_SCALE * lag];
}

/** Class C: ISO 9613-2 bends the path on a 5 km arc; here the ground is level. */
export function foliageMetres(metres, a, b, treeHeightMetres) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  if (high <= treeHeightMetres) return metres;
  if (low >= treeHeightMetres) return 0;
  return metres * (treeHeightMetres - low) / (high - low);
}

const ENERGY_PER_T60 = 6 * Math.LN10;

function forestCutSeconds(band) {
  const { earlyDecibels, earlySeconds, lateDecibels, lateSeconds, cutDecibels } = GROUND.forest;
  const floor = Math.max(earlyDecibels[band], lateDecibels[band]) - cutDecibels;
  const early = earlySeconds[band] * (earlyDecibels[band] - floor) / 60;
  const late = lateSeconds[band] * (lateDecibels[band] - floor) / 60;
  return Math.max(early, late);
}

const FOREST_CUTS = Object.freeze(GROUND.reverbBandsHz.map((_, band) => forestCutSeconds(band)));

/** Energy density re the direct sound per second, faded to nothing over the last fifth before the cut. */
function forestDensity(band, t) {
  const { earlyDecibels, earlySeconds, lateDecibels, lateSeconds } = GROUND.forest;
  const cut = FOREST_CUTS[band];
  if (t >= cut) return 0;
  const fade = Math.min(1, (cut - t) / (.2 * cut));
  const density = 10 ** (earlyDecibels[band] / 10) * Math.exp(-ENERGY_PER_T60 * t / earlySeconds[band])
    + 10 ** (lateDecibels[band] / 10) * Math.exp(-ENERGY_PER_T60 * t / lateSeconds[band]);
  return density * (.5 - .5 * Math.cos(Math.PI * fade));
}

const FOREST = Object.freeze({
  salt: 0,
  name: 'forest',
  lengthSeconds: Math.max(...FOREST_CUTS),
  shape: band => t => (1 - Math.exp(-t / GROUND.forest.buildSeconds)) * Math.sqrt(forestDensity(band, t)),
  share: (band, shape, sampleRate, length) => {
    let energy = 0;
    for (let index = 0; index < length; index += 1) energy += shape(index / sampleRate) ** 2;
    return energy / sampleRate;
  }
});

const SURROUNDINGS = Object.freeze({
  salt: 0x5bd1e995,
  name: 'surroundings',
  lengthSeconds: 70 / 60 * Math.max(...GROUND.surroundings.seconds),
  shape: band => {
    const { seconds, buildSeconds } = GROUND.surroundings;
    const decay = 3 * Math.LN10 / seconds[band];
    return t => (1 - Math.exp(-t / buildSeconds)) * Math.exp(-decay * t);
  },
  share: band => GROUND.surroundings.energyShare * GROUND.surroundings.seconds[band] / GROUND.surroundings.seconds[5]
});

export function forestSeed(id) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}

/**
 * Class C: how strongly a path drives the forest tail, as an amplitude, by its metres under the canopy. The tail takes the
 * energy the trees scatter from the path, which grows as the foliage loss does; at the Koli responses' 9 m it is 1.
 */
export function forestSend(underCanopyMetres) {
  if (!(underCanopyMetres > 0)) return 0;
  const { referenceMetres, scatterDecibelsPerMetre } = GROUND.forest;
  const scattered = metres => 10 ** (scatterDecibelsPerMetre * metres / 10) - 1;
  return Math.sqrt(scattered(underCanopyMetres) / scattered(referenceMetres));
}

export function forestResponses(seed, channels, sampleRate, [first, last] = [0, channels]) {
  return cachedResponses(FOREST, seed, sampleRate, first, last);
}

export function surroundingsResponses(seed, channels, sampleRate, [first, last] = [0, channels]) {
  return cachedResponses(SURROUNDINGS, (seed ^ SURROUNDINGS.salt) >>> 0, sampleRate, first, last);
}

const lastResponses = new Map();

function cachedResponses(profile, seed, sampleRate, first, last) {
  const key = `${seed}:${first}:${last}:${sampleRate}`;
  if (lastResponses.get(profile.name)?.key !== key) lastResponses.set(profile.name, { key, responses: makeResponses(profile, seed, sampleRate, first, last) });
  return lastResponses.get(profile.name).responses;
}

function makeResponses(profile, seed, sampleRate, first, last) {
  const length = Math.ceil(profile.lengthSeconds * sampleRate);
  const size = nextPowerOfTwo(length);
  const binHz = sampleRate / size;
  const bands = GROUND.reverbBandsHz.length;
  const shapes = GROUND.reverbBandsHz.map((_, band) => profile.shape(band));
  const shares = shapes.map((shape, band) => profile.share(band, shape, sampleRate, length));
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
    for (let band = 0; band < bands; band += 2) {
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      const energies = [0, 0];
      for (let part = 0; part < 2 && band + part < bands; part += 1) {
        const weightsOf = weights[band + part];
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
        const shape = shapes[band + part];
        let energy = 0;
        for (let index = 0; index < length; index += 1) {
          signal[index] *= shape(index / sampleRate);
          energy += signal[index] * signal[index];
        }
        const target = shares[band + part] * bandEnergy / (size / 2) / (2 * order + 1);
        const scale = energy > 0 ? Math.sqrt(target / energy) : 0;
        for (let index = 0; index < length; index += 1) response[index] += signal[index] * scale;
      });
    }
    return response;
  });
}

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

/** The forest tail follows `send`, each path's pressure weighted by its `forestSend`; the surroundings follow the pressure and the forest tail. */
export function diffuseTails(pressure, { forest = null, surroundings = null }, channels, send = null) {
  const length = pressure.length + (forest?.[0].length ?? 0) + (surroundings?.[0].length ?? 0);
  const tails = Array.from({ length: channels }, () => new Float64Array(length));
  if (forest && send) {
    const driven = new Float64Array(length);
    driven.set(send);
    addForestTail(tails, forest, driven);
  }
  if (surroundings) {
    const source = new Float64Array(length);
    source.set(pressure);
    if (forest && send) for (let index = 0; index < length; index += 1) source[index] += tails[0][index];
    addForestTail(tails, surroundings, source);
  }
  return tails;
}

export function diffuseTailBytes(length, { forest = null, surroundings = null }, channels, send = false) {
  const kernels = [send ? forest : null, surroundings].filter(Boolean);
  const total = length + (forest?.[0].length ?? 0) + (surroundings?.[0].length ?? 0);
  const lanes = channels + kernels.length;
  const transforms = Math.max(0, ...kernels.map(kernel => (2 * Math.ceil(channels / 2) + 4) * overlapSize(total, kernel[0].length)));
  const responses = [forest, surroundings].filter(Boolean).reduce((sum, kernel) => sum + kernel.length * kernel[0].length, 0);
  return Float64Array.BYTES_PER_ELEMENT * (lanes * total + transforms + length * (send ? 2 : 1) + responses);
}
