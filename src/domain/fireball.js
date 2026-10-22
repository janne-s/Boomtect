import { BLAST } from './constants.js';
import { fft, nextPowerOfTwo } from '../shared/domain/fft.js';
import { createRandom, normalDeviate } from '../shared/domain/random.js';

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

export function spectralNoise(random, size, sampleRate, density) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let index = 0; index < size; index += 1) re[index] = normalDeviate(random);
  fft(re, im);
  for (let bin = 0; bin <= size / 2; bin += 1) {
    const gain = bin === 0 ? 0 : Math.sqrt(density(bin * sampleRate / size));
    re[bin] *= gain; im[bin] *= gain;
    if (bin > 0 && bin < size / 2) { re[size - bin] = re[bin]; im[size - bin] = -im[bin]; }
  }
  fft(re, im, true);
  return re;
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
