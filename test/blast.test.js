import assert from 'node:assert/strict';
import test from 'node:test';
import { BLAST } from '../src/domain/constants.js';
import { secondaryShockDelay, secondaryShockFactors } from '../src/domain/explosives.js';
import { fft, nextPowerOfTwo } from '../src/domain/fft.js';
import { fireballSamples } from '../src/domain/fireball.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { parseScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';

const SAMPLE_RATE = 48000;

function freeBlast(emitter, distance) {
  const scene = plainScene('blast');
  scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
  scene.ground = { ...scene.ground, enabled: false };
  scene.emitters[0] = { ...scene.emitters[0], positionMetres: { x: 0, y: 0, z: 100 }, ...emitter };
  scene.receivers[0].positionMetres = { x: distance, y: 0, z: 100 };
  const value = parseScene(scene);
  return renderReceiver(prepareScene(value), value.receivers[0], value);
}

test('the secondary shock delay reproduces Rigby & Gitterman’s worked example: 2.299 ms at 2 m from 250 g PE4 gives 8 299 m/s', () => {
  // τ = t·V/(ρW)^⅓ = 2.45 log₁₀ Z + 1.36 = 2.589 at Z = 3.175; solved for V with their delay.
  const { delaySeconds, cubeRootKilograms } = secondaryShockFactors('pe4', .25);
  const delay = secondaryShockDelay(delaySeconds, cubeRootKilograms, 2);
  const velocity = 8193 * delay / 2.299e-3;
  assert.ok(Math.abs(velocity - 8299) < 15, `${velocity}`);
});

test('the secondary shock arrives its delay after the primary', () => {
  const distance = 400;
  const result = freeBlast({ fireballDecibels: -60 }, distance);
  const primary = result.samples.findIndex(sample => sample > .5 * result.peakPa);
  const { delaySeconds, cubeRootKilograms } = secondaryShockFactors('tnt', 10);
  const expected = primary + Math.round(secondaryShockDelay(delaySeconds, cubeRootKilograms, distance) * SAMPLE_RATE);
  // The steepest rise near the expected arrival.
  let best = 0;
  let at = 0;
  for (let index = expected - 480; index < expected + 480; index += 1) {
    const rise = result.samples[index + 1] - result.samples[index];
    if (rise > best) { best = rise; at = index; }
  }
  assert.ok(Math.abs(at - expected) <= 3, `${at - expected} samples`);
});

test('the roar is seeded, peaks at unit RMS over 50 ms, falls 30 dB over its duration, and has the recordings’ spectrum', () => {
  const duration = 1;
  const samples = fireballSamples(7, duration, SAMPLE_RATE);
  assert.deepEqual(fireballSamples(7, duration, SAMPLE_RATE), samples);
  assert.notDeepEqual(fireballSamples(8, duration, SAMPLE_RATE), samples);
  const window = Math.round(BLAST.roar.windowSeconds * SAMPLE_RATE);
  const rms = start => Math.sqrt(samples.slice(start, start + window).reduce((sum, value) => sum + value * value, 0) / window);
  let largest = 0;
  for (let start = 0; start + window <= samples.length; start += window >> 2) largest = Math.max(largest, rms(start));
  assert.ok(Math.abs(largest - 1) < 1e-9);
  const fall = 20 * Math.log10(rms(Math.round((duration + .1) * SAMPLE_RATE)) / rms(Math.round(.1 * SAMPLE_RATE)));
  assert.ok(fall < -26 && fall > -34, `${fall}`);
  // Band shares 0.1–0.3 s after onset, against the recordings' means (dB of the window's energy).
  const segment = samples.slice(Math.round(.1 * SAMPLE_RATE), Math.round(.3 * SAMPLE_RATE));
  const size = nextPowerOfTwo(segment.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(segment);
  fft(re, im);
  const energy = (low, high) => {
    let sum = 0;
    for (let bin = 1; bin < size / 2; bin += 1) {
      const frequency = bin * SAMPLE_RATE / size;
      if (frequency >= low && frequency < high) sum += re[bin] ** 2 + im[bin] ** 2;
    }
    return sum;
  };
  const total = energy(0, SAMPLE_RATE / 2);
  const measured = [[20, 80, -11], [80, 250, -4], [250, 1000, -4], [1000, 4000, -9], [4000, 16000, -26]];
  for (const [low, high, expected] of measured) {
    const share = 10 * Math.log10(energy(low, high) / total);
    assert.ok(Math.abs(share - expected) < 3, `${low}–${high} Hz: ${share}`);
  }
});

test('at the microphone the roar peaks its Fireball level below the shock’s linear amplitude', () => {
  const distance = 400;
  const both = freeBlast({ secondaryShock: false, fireballDecibels: -20 }, distance);
  const shock = freeBlast({ secondaryShock: false, fireballDecibels: -60 }, distance);
  const offset = Math.round((both.startSeconds - shock.startSeconds) * SAMPLE_RATE);
  const roar = both.samples.map((value, index) => value - (shock.samples[index + offset] ?? 0));
  const window = Math.round(BLAST.roar.windowSeconds * SAMPLE_RATE);
  let largest = 0;
  for (let start = 0; start + window <= roar.length; start += window >> 2) {
    let sum = 0;
    for (let index = start; index < start + window; index += 1) sum += roar[index] ** 2;
    largest = Math.max(largest, Math.sqrt(sum / window));
  }
  const [{ sources }] = prepareScene(parseScene({ ...plainScene('blast'), emitters: [{ ...plainScene('blast').emitters[0], secondaryShock: false }] }));
  const linear = sources.amplitudePaMetres[0] / distance;
  const level = 20 * Math.log10(largest / linear);
  assert.ok(Math.abs(level + 20) < 1, `${level}`);
});

test('convolution adds the linear convolution of two signals, as a direct sum does', async () => {
  const { convolveAdd } = await import('../src/domain/fft.js');
  const signal = Float64Array.from({ length: 37 }, (_, index) => Math.sin(index * .7) + (index % 5));
  const kernel = Float64Array.from({ length: 23 }, (_, index) => Math.cos(index * 1.3) / (index + 1));
  const target = new Float64Array(70).fill(1);
  convolveAdd([target], [signal], kernel);
  for (let index = 0; index < target.length; index += 1) {
    let sum = 1;
    for (let k = 0; k < kernel.length; k += 1) if (index - k >= 0 && index - k < signal.length) sum += signal[index - k] * kernel[k];
    assert.ok(Math.abs(target[index] - sum) < 1e-9, `${index}`);
  }
});

/** The direct linear convolution of a signal with a kernel, `length` samples long. */
function directConvolution(signal, kernel, length) {
  return Float64Array.from({ length }, (_, index) => {
    let sum = 0;
    for (let k = 0; k < kernel.length; k += 1) if (index - k >= 0 && index - k < signal.length) sum += signal[index - k] * kernel[k];
    return sum;
  });
}

test('convolution of a long signal in blocks, three signals sharing transforms, matches direct sums', async () => {
  const { convolveAdd } = await import('../src/domain/fft.js');
  // Far longer than four kernels, so that it runs in several overlapping blocks, and an odd count so one signal goes alone.
  const signals = [0, 1, 2].map(channel => Float64Array.from({ length: 1000 + 37 * channel }, (_, index) => Math.sin(index * (.3 + .2 * channel)) * Math.exp(-index / 600)));
  const kernel = Float64Array.from({ length: 29 }, (_, index) => Math.cos(index * .9) / (index + 1));
  const targets = signals.map(() => new Float64Array(1100).fill(.5));
  convolveAdd(targets, signals, kernel);
  targets.forEach((target, channel) => {
    const expected = directConvolution(signals[channel], kernel, target.length);
    for (let index = 0; index < target.length; index += 1) assert.ok(Math.abs(target[index] - .5 - expected[index]) < 1e-9, `${channel}:${index}`);
  });
});

test('a diffuse tail adds the omnidirectional pressure convolved with each channel own response, in blocks', async () => {
  const { addForestTail } = await import('../src/domain/forest.js');
  const outputs = [0, 1, 2].map(channel => Float64Array.from({ length: 900 }, (_, index) => (index < 600 ? Math.sin(index * (.4 + .1 * channel)) : 0)));
  const pressure = outputs[0].slice();
  const responses = [0, 1, 2].map(channel => Float64Array.from({ length: 40 }, (_, index) => Math.exp(-index / (8 + channel)) * Math.cos(index * .5)));
  const before = outputs.map(output => output.slice());
  addForestTail(outputs, responses);
  outputs.forEach((output, channel) => {
    const expected = directConvolution(pressure, responses[channel], output.length);
    for (let index = 0; index < output.length; index += 1) assert.ok(Math.abs(output[index] - before[channel][index] - expected[index]) < 1e-9, `${channel}:${index}`);
  });
});
