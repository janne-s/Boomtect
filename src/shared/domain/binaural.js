import { channelCount, orientationRotation } from './ambisonics.js';
import { convolveAdd } from './fft.js';
import { SADIE_HRIR } from './sadie-hrir.js';

const negativeDegree = acn => {
  const degree = Math.floor(Math.sqrt(acn));
  return acn - degree * degree - degree < 0;
};

const CROSSOVER_HZ = 150;
const FILTER_LENGTH = 2048;
const HEAD_DELAY_SECONDS = -1.5 * .0875 / 343;

function pcm16File(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let channels = 1;
  let sampleRate = 48000;
  for (let offset = 12; offset + 8 <= bytes.length; offset += 8 + view.getUint32(offset + 4, true)) {
    if (tag(offset) === 'fmt ') { channels = view.getUint16(offset + 10, true); sampleRate = view.getUint32(offset + 12, true); }
    if (tag(offset) !== 'data') continue;
    const frames = view.getUint32(offset + 4, true) / (2 * channels);
    return { sampleRate, channels: Array.from({ length: channels }, (_, channel) => Float64Array.from({ length: frames }, (__, frame) => view.getInt16(offset + 8 + 2 * (frame * channels + channel), true) / 32768)) };
  }
  throw new Error('The HRIR holds no data.');
}

function lowpass(samples, frequencyHz, sampleRate) {
  const w = 2 * Math.PI * frequencyHz / sampleRate;
  const alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const [b0, b1, b2, a1, a2] = [(1 - Math.cos(w)) / 2 / a0, (1 - Math.cos(w)) / a0, (1 - Math.cos(w)) / 2 / a0, -2 * Math.cos(w) / a0, (1 - alpha) / a0];
  let output = samples;
  for (let pass = 0; pass < 2; pass += 1) {
    const input = output;
    output = new Float64Array(input.length);
    let [x1, x2, y1, y2] = [0, 0, 0, 0];
    for (let index = 0; index < input.length; index += 1) {
      const y = b0 * input[index] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      [x2, x1, y2, y1] = [x1, input[index], y1, y];
      output[index] = y;
    }
  }
  return output;
}

function energyCentre(kernel) {
  const total = kernel.reduce((sum, value) => sum + value * value, 0);
  let sum = 0;
  for (let index = 0; index < kernel.length; index += 1) {
    sum += kernel[index] ** 2;
    if (sum >= total / 2) return index;
  }
  return 0;
}

/** Class A below the crossover, where the head is small against the wavelength. */
function withPressureBass(kernels, sampleRate) {
  const delay = energyCentre(kernels[0]);
  return kernels.map((kernel, acn) => {
    const padded = new Float64Array(FILTER_LENGTH);
    padded.set(kernel);
    const target = new Float64Array(FILTER_LENGTH);
    if (acn === 0) target[delay] = 1;
    if (acn === 1) { target[delay - 1] = -HEAD_DELAY_SECONDS * sampleRate / 2; target[delay + 1] = HEAD_DELAY_SECONDS * sampleRate / 2; }
    const low = lowpass(target.map((value, index) => value - padded[index]), CROSSOVER_HZ, sampleRate);
    return padded.map((value, index) => value + low[index]);
  });
}

const filters = new Map();
function hrirs(order) {
  if (!filters.has(order)) {
    const files = SADIE_HRIR[order].map(text => pcm16File(Uint8Array.from(atob(text), character => character.charCodeAt(0))));
    filters.set(order, withPressureBass(files.flatMap(file => file.channels).slice(0, channelCount(order)), files[0].sampleRate));
  }
  return filters.get(order);
}

/** The corrected filters as Omnitone loads them: stereo 16-bit WAVs holding the ACN channels in pairs. */
export function hrirFiles(order) {
  const kernels = hrirs(order);
  return SADIE_HRIR[order].map((text, file) => {
    const sampleRate = pcm16File(Uint8Array.from(atob(text), character => character.charCodeAt(0))).sampleRate;
    const pair = [kernels[2 * file], kernels[2 * file + 1] ?? new Float64Array(FILTER_LENGTH)];
    const bytes = new Uint8Array(44 + 4 * FILTER_LENGTH);
    const view = new DataView(bytes.buffer);
    const text4 = (at, value) => [...value].forEach((char, index) => { bytes[at + index] = char.charCodeAt(0); });
    text4(0, 'RIFF'); view.setUint32(4, 36 + 4 * FILTER_LENGTH, true); text4(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, 4 * sampleRate, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
    text4(36, 'data'); view.setUint32(40, 4 * FILTER_LENGTH, true);
    for (let frame = 0; frame < FILTER_LENGTH; frame += 1) {
      pair.forEach((kernel, channel) => view.setInt16(44 + 4 * frame + 2 * channel, Math.max(-32768, Math.min(32767, Math.round(kernel[frame] * 32768))), true));
    }
    return bytes;
  });
}

export function binauralChannels(channels, order, headingDegrees = 0, pitchDegrees = 0) {
  const length = channels[0].length;
  const rotated = Array.from({ length: channelCount(order) }, () => new Float64Array(length));
  for (const { from, to, gain } of orientationRotation(headingDegrees, pitchDegrees, order)) {
    const [source, target] = [channels[from], rotated[to]];
    for (let index = 0; index < length; index += 1) target[index] += gain * source[index];
  }
  const kernels = hrirs(order);
  const ears = [new Float64Array(length + kernels[0].length - 1), new Float64Array(length + kernels[0].length - 1)];
  kernels.forEach((kernel, acn) => {
    const signal = rotated[acn];
    convolveAdd(ears, [signal, negativeDegree(acn) ? signal.map(value => -value) : signal], kernel);
  });
  return ears;
}
