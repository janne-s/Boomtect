import assert from 'node:assert/strict';
import test from 'node:test';
import { fft, nextPowerOfTwo } from '../src/domain/fft.js';
import { FOLIAGE_BANDS_HZ, FOLIAGE_DECIBELS_PER_METRE, foliageExponent, foliageMetres, forestResponses } from '../src/domain/forest.js';
import { combineSegments, partitionSeconds, prepareScene, renderReceiver, renderReceiverRange } from '../src/domain/render.js';
import { defaultScene, parseScene } from '../src/domain/scene.js';

const SAMPLE_RATE = 48000;

function forestBlast({ distance = 400, forest = true } = {}) {
  const scene = defaultScene('blast');
  scene.ground = { ...scene.ground, forest };
  scene.receivers[0].positionMetres = { x: distance, y: 0, z: 1.7 };
  return parseScene(scene);
}

test('the causal foliage loss follows ISO 9613-2 Table A.1 within 0.006 dB/m in every band', () => {
  FOLIAGE_BANDS_HZ.forEach((frequency, band) => {
    const decibels = foliageExponent(frequency)[0] * 20 / Math.LN10;
    assert.ok(Math.abs(decibels - FOLIAGE_DECIBELS_PER_METRE[band]) < .006, `${frequency} Hz: ${decibels}`);
  });
});

test('only the part of a straight path under the canopy passes through foliage', () => {
  assert.equal(foliageMetres(300, 1, 1.7, 15), 300);
  assert.equal(foliageMetres(300, 20, 40, 15), 0);
  // From 5 m up to 25 m: half of the climb lies under 15 m.
  assert.ok(Math.abs(foliageMetres(300, 25, 5, 15) - 150) < 1e-9);
});

test('the forest tail holds its share of each band and decays in the Koli time at 1 kHz', () => {
  const [response] = forestResponses(7, 1, SAMPLE_RATE);
  const size = nextPowerOfTwo(response.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(response);
  fft(re, im);
  // Against a unit impulse, whose energy per bin is 1: about −10 dB at 1 kHz, less at the ends.
  const share = (low, high) => {
    let energy = 0;
    let bins = 0;
    for (let bin = 1; bin < size / 2; bin += 1) {
      const frequency = bin * SAMPLE_RATE / size;
      if (frequency >= low && frequency < high) { energy += re[bin] ** 2 + im[bin] ** 2; bins += 1; }
    }
    return 10 * Math.log10(energy / bins);
  };
  const middle = share(700, 1400);
  assert.ok(middle > -11 && middle < -7, `${middle}`);
  assert.ok(share(20, 100) < middle - 5);
  // Schroeder decay of the 1 kHz octave, −5 to −35 dB, extrapolated to 60 dB.
  const band = new Float64Array(size);
  const bandIm = new Float64Array(size);
  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = bin * SAMPLE_RATE / size;
    if (frequency < 707 || frequency >= 1414) continue;
    band[bin] = re[bin]; bandIm[bin] = im[bin];
    band[size - bin] = re[bin]; bandIm[size - bin] = -im[bin];
  }
  fft(band, bandIm, true);
  const remaining = new Float64Array(response.length);
  for (let index = response.length - 1, sum = 0; index >= 0; index -= 1) { sum += band[index] ** 2; remaining[index] = sum; }
  const level = index => 10 * Math.log10(remaining[index] / remaining[0]);
  const at = decibels => remaining.findIndex((_, index) => level(index) <= decibels) / SAMPLE_RATE;
  const t30 = 2 * (at(-35) - at(-5));
  assert.ok(t30 > 1.3 && t30 < 1.7, `${t30}`);
});

test('a diffuse tail gives each first-order Ambisonic channel a third of the omnidirectional energy', () => {
  const responses = forestResponses(11, 4, SAMPLE_RATE);
  const energy = response => response.reduce((sum, value) => sum + value * value, 0);
  for (let channel = 1; channel < 4; channel += 1) {
    const ratio = energy(responses[channel]) / energy(responses[0]);
    assert.ok(Math.abs(ratio - 1 / 3) < .03, `${channel}: ${ratio}`);
  }
  assert.deepEqual(forestResponses(11, 4, SAMPLE_RATE)[2], responses[2]);
});

test('in a forest nothing arrives before the blast, and its tail follows it', () => {
  const scene = forestBlast();
  const result = renderReceiver(prepareScene(scene), scene.receivers[0], scene);
  const openScene = forestBlast({ forest: false });
  const open = renderReceiver(prepareScene(openScene), openScene.receivers[0], openScene);
  const arrival = 400 / 340.3;
  const energy = (samples, start, from, to) => samples.reduce((sum, value, index) => {
    const seconds = start + index / SAMPLE_RATE;
    return seconds >= from && seconds < to ? sum + value * value : sum;
  }, 0);
  const total = energy(result.samples, result.startSeconds, -Infinity, Infinity);
  assert.ok(result.samples.every(Number.isFinite));
  assert.ok(energy(result.samples, result.startSeconds, -Infinity, arrival - .01) / total < 1e-7);
  assert.ok(energy(result.samples, result.startSeconds, arrival + .3, arrival + 1.5) > 1e3 * energy(open.samples, open.startSeconds, arrival + .3, arrival + 1.5));
});

test('rendered in two ranges, a forest scene sums to the whole render', () => {
  const scene = forestBlast({ distance: 400 });
  // Two blasts so that each range holds one.
  const second = { ...scene.emitters[0], id: 'blast-2', positionMetres: { x: -300, y: 200, z: 1 }, startSeconds: .5 };
  const value = parseScene({ ...scene, emitters: [scene.emitters[0], second] });
  const prepared = prepareScene(value);
  const receiver = value.receivers[0];
  const whole = renderReceiver(prepared, receiver, value);
  const boundaries = partitionSeconds(prepared, value, 2);
  const parts = [0, 1].map(part => renderReceiverRange(prepared, receiver, value, { fromSeconds: boundaries[part], toSeconds: boundaries[part + 1] }));
  const combined = combineSegments(parts, SAMPLE_RATE);
  assert.equal(combined.startSeconds, whole.startSeconds);
  const peak = whole.peakPa;
  let error = 0;
  whole.samples.forEach((value, index) => { error = Math.max(error, Math.abs(value - (combined.channels[0][index] ?? 0))); });
  assert.ok(error / peak < 1e-6, `${error / peak}`);
});
