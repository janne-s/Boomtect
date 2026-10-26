/** A whole scene rendered outside the page, for tools and agents: files at the app's export gain and measurements to read without listening. */
import { RENDER } from './constants.js';
import { nextPowerOfTwo, realSpectrum } from './fft.js';
import { loudestDecibelsA, pressureDecibels } from './levels.js';
import { renderReceiver } from './render.js';
import { encodeFloat32Wav } from './wav.js';

export const OCTAVES_HZ = Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
export const AMBIX_CONVENTION = 'AmbiX (ACN, SN3D); front = north, left = west, up = up';
const SPECTRUM_SIZE = 8192;
const AUDIBLE_SPAN_DECIBELS = 40;

const slug = text => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mic';

function loudestSecond(samples, sampleRate) {
  const length = Math.min(samples.length, sampleRate);
  const step = Math.max(1, Math.round(length / 4));
  let [best, start] = [-1, 0];
  for (let from = 0; from + length <= samples.length; from += step) {
    let sum = 0;
    for (let index = from; index < from + length; index += 1) sum += samples[index] ** 2;
    if (sum > best) [best, start] = [sum, from];
  }
  return { start, length };
}

function powerSpectrum(samples) {
  const size = Math.min(SPECTRUM_SIZE, nextPowerOfTwo(samples.length));
  const hann = Float64Array.from({ length: size }, (_, index) => .5 - .5 * Math.cos(2 * Math.PI * index / size));
  const power = new Float64Array(size / 2 + 1);
  for (let from = 0; from === 0 || from + size <= samples.length; from += size / 2) {
    const block = Float64Array.from(hann, (weight, index) => weight * (samples[from + index] ?? 0));
    const { re, im } = realSpectrum(block);
    for (let bin = 1; bin < power.length; bin += 1) power[bin] += re[bin] ** 2 + im[bin] ** 2;
  }
  return { power, size };
}

/** Length, levels, and the spectral shape of the loudest second of one pressure signal in pascals. */
export function measureSound(samples, sampleRate) {
  const peakPa = samples.reduce((top, value) => Math.max(top, Math.abs(value)), 0);
  const { start, length } = loudestSecond(samples, sampleRate);
  const { power, size } = powerSpectrum(samples.subarray(start, start + length));
  const hz = bin => bin * sampleRate / size;
  let [weighted, total] = [0, 0];
  for (let bin = 1; bin < power.length; bin += 1) [weighted, total] = [weighted + power[bin] * hz(bin), total + power[bin]];
  const bands = OCTAVES_HZ.map(centre => {
    let sum = 0;
    for (let bin = 1; bin < power.length; bin += 1) if (hz(bin) >= centre / Math.SQRT2 && hz(bin) < centre * Math.SQRT2) sum += power[bin];
    return sum;
  });
  const loudestBand = Math.max(...bands, 1e-300);
  const threshold = (peakPa * 10 ** (-AUDIBLE_SPAN_DECIBELS / 20)) ** 2;
  let [first, last] = [-1, -1];
  for (let index = 0; index < samples.length; index += 1) if (samples[index] ** 2 > threshold) [first, last] = [first < 0 ? index : first, index];
  const decibels = value => +value.toFixed(1);
  return {
    durationSeconds: +(samples.length / sampleRate).toFixed(2),
    withinFortyDecibelsSeconds: first < 0 ? 0 : +((last - first) / sampleRate).toFixed(2),
    peakDecibelsSpl: peakPa > 0 ? decibels(pressureDecibels(peakPa)) : null,
    loudestDecibelsAFast: peakPa > 0 ? decibels(loudestDecibelsA(samples, sampleRate)) : null,
    loudestSecondAt: +(start / sampleRate).toFixed(2),
    spectralCentroidHz: total > 0 ? Math.round(weighted / total) : 0,
    octaveShapeDecibels: Object.fromEntries(OCTAVES_HZ.map((centre, index) => [`${centre} Hz`, decibels(10 * Math.log10(Math.max(bands[index], 1e-300) / loudestBand))]))
  };
}

/**
 * Every microphone of a read scene as WAV files, the filled scene, and a summary. `tect` gives the tect's own `prepareScene` and
 * `serializeScene`. Gain as the app exports: 'fixed' puts `render.fullScalePa` at full scale, 'peak' the loudest microphone 3 dB below it.
 */
export function renderSceneFiles(scene, tect, { ambix = false } = {}) {
  const started = performance.now();
  const prepared = tect.prepareScene(scene);
  const results = scene.receivers.map(receiver => ({ receiver, result: renderReceiver(prepared, receiver, scene) }));
  const loudestPa = Math.max(0, ...results.map(({ result }) => result.peakPa));
  const gain = scene.render.levelMode === 'fixed' ? 1 / scene.render.fullScalePa : loudestPa > 0 ? RENDER.peakTarget / loudestPa : 1;
  const names = new Set();
  const files = [];
  const microphones = results.map(({ receiver, result }) => {
    let name = `${slug(receiver.name)}.wav`;
    for (let count = 2; names.has(name); count += 1) name = `${slug(receiver.name)}-${count}.wav`;
    names.add(name);
    const channels = (ambix ? result.channels : [result.channels[0]]).map(channel => Float32Array.from(channel, value => value * gain));
    files.push({ name, data: new Uint8Array(encodeFloat32Wav(channels, result.sampleRate)) });
    return { file: name, name: receiver.name, channels: channels.length, positionMetres: receiver.positionMetres, ...measureSound(result.channels[0], result.sampleRate) };
  });
  files.push({ name: 'scene.json', data: new TextEncoder().encode(`${tect.serializeScene(scene)}\n`) });
  return {
    files,
    summary: {
      scene: 'scene.json',
      fullScalePa: +(1 / gain).toPrecision(4),
      ambisonicConvention: ambix ? AMBIX_CONVENTION : undefined,
      modelVersion: scene.modelVersion,
      renderSeconds: +((performance.now() - started) / 1000).toFixed(1),
      microphones
    }
  };
}
