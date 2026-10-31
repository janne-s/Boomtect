import { BLAST } from './constants.js';
import { fft, nextPowerOfTwo } from '../shared/domain/fft.js';
import { createRandom, normalDeviate, normalDeviates } from '../shared/domain/random.js';

/** Class C, fitted to open-field charge recordings (FBI video, Doc/reference/audio). */

export const fireballSpanSeconds = durationSeconds => BLAST.roar.riseSeconds * 5 + durationSeconds * 70 / BLAST.roar.durationDecibels;

export function tableDensity(spectrumHz, spectrumDensity) {
  const first = spectrumHz[0];
  const last = spectrumHz.length - 1;
  return frequencyHz => {
    if (frequencyHz <= first) return spectrumDensity[0] * (frequencyHz / first) ** 2;
    let band = 0;
    while (band < last - 1 && frequencyHz > spectrumHz[band + 1]) band += 1;
    const slope = Math.log(spectrumDensity[band + 1] / spectrumDensity[band]) / Math.log(spectrumHz[band + 1] / spectrumHz[band]);
    return spectrumDensity[band] * (frequencyHz / spectrumHz[band]) ** slope;
  };
}

const density = tableDensity(BLAST.roar.spectrumHz, BLAST.roar.spectrumDensity);

const gainTables = new WeakMap();

function spectralGains(density, size, sampleRate) {
  if (!gainTables.has(density)) gainTables.set(density, new Map());
  const tables = gainTables.get(density);
  const key = `${size}:${sampleRate}`;
  if (!tables.has(key)) tables.set(key, Float64Array.from({ length: size / 2 + 1 }, (_, bin) => (bin === 0 ? 0 : Math.sqrt(density(bin * sampleRate / size)))));
  return tables.get(key);
}

export function spectralNoise(random, size, sampleRate, density) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let index = 0; index < size; index += 1) re[index] = normalDeviate(random);
  fft(re, im);
  const gains = spectralGains(density, size, sampleRate);
  for (let bin = 0; bin <= size / 2; bin += 1) {
    const gain = gains[bin];
    re[bin] *= gain; im[bin] *= gain;
    if (bin > 0 && bin < size / 2) { re[size - bin] = re[bin]; im[size - bin] = -im[bin]; }
  }
  fft(re, im, true);
  return re;
}

/** Class A: two independent noises from one inverse transform, white Gaussian spectra drawn bin by bin, the first heard in the real part and the second in the imaginary. */
export function spectralNoisePair(random, size, sampleRate, [firstDensity, secondDensity]) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const half = size / 2;
  const deviates = normalDeviates(random, 4 * half);
  const spread = Math.sqrt(half);
  const [first, second] = [spectralGains(firstDensity, size, sampleRate), spectralGains(secondDensity, size, sampleRate)];
  for (let bin = 1; bin < half; bin += 1) {
    const [aRe, aIm, bRe, bIm] = [0, 1, 2, 3].map(offset => spread * deviates[4 * bin + offset]);
    const [ga, gb] = [first[bin], second[bin]];
    re[bin] = ga * aRe - gb * bIm; im[bin] = ga * aIm + gb * bRe;
    re[size - bin] = ga * aRe + gb * bIm; im[size - bin] = -ga * aIm + gb * bRe;
  }
  re[half] = Math.SQRT2 * spread * first[half] * deviates[0];
  im[half] = Math.SQRT2 * spread * second[half] * deviates[1];
  fft(re, im, true);
  return [re, im];
}

export function scaleToLoudestWindow(samples, window) {
  let largest = 0;
  for (let start = 0; start + window <= samples.length; start += window >> 2) {
    let sum = 0;
    for (let index = start; index < start + window; index += 1) sum += samples[index] ** 2;
    largest = Math.max(largest, sum / window);
  }
  const scale = largest > 0 ? 1 / Math.sqrt(largest) : 0;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= scale;
  return samples;
}

export function fireballSamples(seed, durationSeconds, sampleRate) {
  const length = Math.ceil(fireballSpanSeconds(durationSeconds) * sampleRate);
  const re = spectralNoise(createRandom(seed), nextPowerOfTwo(length), sampleRate, density);
  const decay = BLAST.roar.durationDecibels / 20 * Math.LN10 / durationSeconds;
  const samples = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const t = index / sampleRate;
    samples[index] = re[index] * (1 - Math.exp(-t / BLAST.roar.riseSeconds)) * Math.exp(-decay * t);
  }
  return scaleToLoudestWindow(samples, Math.max(1, Math.round(BLAST.roar.windowSeconds * sampleRate)));
}
