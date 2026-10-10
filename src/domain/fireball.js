import { fft, nextPowerOfTwo } from './fft.js';
import { createRandom, normalDeviate } from './random.js';

/**
 * The roar after a blast's shock: the fireball, afterburning, and thrown earth and debris, which go
 * on for about a second after the shock while the shock itself lasts milliseconds. Class C
 * throughout: a seeded noise burst fitted to recordings of improvised charges set off on an open
 * grass field (FBI video, at least about 100 m, camera audio whose level control lifts the tail and
 * whose clipped peaks lower the shock; Doc/reference/audio). Its sources are those of the shock.
 *
 * Measured in the recordings 0.1–0.3 s after the shock (mean of four, band energies against the
 * window's total): 20–80 Hz −11 dB, 80–250 Hz −4 dB, 250–1000 Hz −4 dB, 1–4 kHz −9 dB, 4–16 kHz −26 dB,
 * here as power spectral density at the band centres, log-interpolated, falling as f² below the
 * first; the 8 kHz density is set so that the 4–16 kHz share comes out as measured (−26.6 dB).
 */
const SPECTRUM_HZ = Object.freeze([40, 141, 500, 2000, 8000, 16000]);
const SPECTRUM_DENSITY = Object.freeze([1.3e-3, 2.3e-3, 5.3e-4, 4.2e-5, 6e-8, 1e-9]);
/** The roar rises over a few milliseconds after the shock and falls by 30 dB over its duration. */
const RISE_SECONDS = .01;
const DURATION_DECIBELS = 30;
/** Its level is the largest RMS over a window this long. */
export const FIREBALL_WINDOW_SECONDS = .05;

/** Time after the shock by which the roar has fallen 70 dB. */
export const fireballSpanSeconds = durationSeconds => RISE_SECONDS * 5 + durationSeconds * 70 / DURATION_DECIBELS;

function density(frequencyHz) {
  const first = SPECTRUM_HZ[0];
  const last = SPECTRUM_HZ.length - 1;
  if (frequencyHz <= first) return SPECTRUM_DENSITY[0] * (frequencyHz / first) ** 2;
  let band = 0;
  while (band < last - 1 && frequencyHz > SPECTRUM_HZ[band + 1]) band += 1;
  const slope = Math.log(SPECTRUM_DENSITY[band + 1] / SPECTRUM_DENSITY[band]) / Math.log(SPECTRUM_HZ[band + 1] / SPECTRUM_HZ[band]);
  return SPECTRUM_DENSITY[band] * (frequencyHz / SPECTRUM_HZ[band]) ** slope;
}

/**
 * The roar's samples per unit level: shaped noise under its envelope, scaled so that its largest
 * RMS over FIREBALL_WINDOW_SECONDS is 1. Deterministic from the seed.
 */
export function fireballSamples(seed, durationSeconds, sampleRate) {
  const length = Math.ceil(fireballSpanSeconds(durationSeconds) * sampleRate);
  const size = nextPowerOfTwo(length);
  const random = createRandom(seed);
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
  const decay = DURATION_DECIBELS / 20 * Math.LN10 / durationSeconds;
  const samples = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const t = index / sampleRate;
    samples[index] = re[index] * (1 - Math.exp(-t / RISE_SECONDS)) * Math.exp(-decay * t);
  }
  const window = Math.max(1, Math.round(FIREBALL_WINDOW_SECONDS * sampleRate));
  let largest = 0;
  for (let start = 0; start + window <= length; start += window >> 2) {
    let sum = 0;
    for (let index = start; index < start + window; index += 1) sum += samples[index] ** 2;
    largest = Math.max(largest, sum / window);
  }
  const scale = largest > 0 ? 1 / Math.sqrt(largest) : 0;
  for (let index = 0; index < length; index += 1) samples[index] *= scale;
  return samples;
}
