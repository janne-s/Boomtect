import assert from 'node:assert/strict';
import test from 'node:test';
import { GROUND } from '../src/domain/constants.js';
import { fft, nextPowerOfTwo } from '../src/shared/domain/fft.js';
import { foliageExponent, foliageMetres, forestResponses, forestSend } from '../src/shared/domain/forest.js';
import { combineWithTails, joinResponses, partitionSeconds, prepareScene, renderReceiver, renderReceiverRange, tailResponses } from '../src/domain/render.js';
import { parseScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';

const SAMPLE_RATE = 48000;

function forestBlast({ distance = 400, forest = true } = {}) {
  const scene = plainScene('blast');
  scene.ground = { ...scene.ground, forest };
  scene.emitters[0] = { ...scene.emitters[0], secondaryShock: false, fireballDecibels: -60 };
  scene.receivers[0].positionMetres = { x: distance, y: 0, z: 1.7 };
  return parseScene(scene);
}

test('the causal foliage loss follows ISO 9613-2 Table A.1 within 0.006 dB/m in every band', () => {
  GROUND.foliageBandsHz.forEach((frequency, band) => {
    const decibels = foliageExponent(frequency)[0] * 20 / Math.LN10;
    assert.ok(Math.abs(decibels - GROUND.foliageDecibelsPerMetre[band]) < .006, `${frequency} Hz: ${decibels}`);
  });
});

test('only the part of a straight path under the canopy passes through foliage', () => {
  assert.equal(foliageMetres(300, 1, 1.7, 15), 300);
  assert.equal(foliageMetres(300, 20, 40, 15), 0);
  // From 5 m up to 25 m: half of the climb lies under 15 m.
  assert.ok(Math.abs(foliageMetres(300, 25, 5, 15) - 150) < 1e-9);
});

test('the forest tail follows the Koli responses at 1 kHz: about −9 dB of the sound that drives it, as Koli\'s tail of its direct sound and ground reflection, falling 10–16 dB by 0.1 s and 18–30 dB by 0.3 s', () => {
  const [response] = forestResponses(7, 1, SAMPLE_RATE);
  const size = nextPowerOfTwo(response.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(response);
  fft(re, im);
  const band = new Float64Array(size);
  const bandIm = new Float64Array(size);
  let bins = 0;
  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = bin * SAMPLE_RATE / size;
    if (frequency < 707 || frequency >= 1414) continue;
    band[bin] = re[bin]; bandIm[bin] = im[bin];
    band[size - bin] = re[bin]; bandIm[size - bin] = -im[bin];
    bins += 1;
  }
  fft(band, bandIm, true);
  const energy = (from, to) => {
    let sum = 0;
    for (let index = Math.round(from * SAMPLE_RATE); index < Math.min(response.length, Math.round(to * SAMPLE_RATE)); index += 1) sum += band[index] ** 2;
    return sum;
  };
  // A unit impulse has 2·bins/size of its energy in the octave.
  const total = 10 * Math.log10(energy(0, Infinity) / (2 * bins / size));
  assert.ok(total > -11 && total < -8, `${total}`);
  const density = (from, to) => 10 * Math.log10(energy(from, to) / (to - from) / (2 * bins / size));
  const start = density(.005, .02);
  assert.ok(start - density(.1, .2) > 9 && start - density(.1, .2) < 16, `${start - density(.1, .2)}`);
  assert.ok(start - density(.3, .5) > 18 && start - density(.3, .5) < 30, `${start - density(.3, .5)}`);
});

test('a path drives the forest tail by the energy its foliage scatters: as at Koli at 9 m, none in the open, more deep in the trees', () => {
  assert.equal(forestSend(0), 0);
  assert.ok(Math.abs(forestSend(9) - 1) < 1e-12);
  assert.ok(Math.abs(forestSend(4.5) ** 2 - .5) < .02);
  assert.ok(forestSend(200) ** 2 > 50 && forestSend(200) ** 2 < 200);
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

test('rendered in two ranges with the tails added to their sum in stretches, a forest scene matches the whole render', () => {
  const scene = forestBlast({ distance: 400 });
  const second = { ...scene.emitters[0], id: 'blast-2', positionMetres: { x: -300, y: 200, z: 1 }, startSeconds: .5 };
  const value = parseScene({ ...scene, emitters: [scene.emitters[0], second] });
  const prepared = prepareScene(value);
  const receiver = value.receivers[0];
  const whole = renderReceiver(prepared, receiver, value);
  const boundaries = partitionSeconds(prepared, value, 2);
  const parts = [0, 1].map(part => renderReceiverRange(prepared, receiver, value, { fromSeconds: boundaries[part], toSeconds: boundaries[part + 1] }));
  const combined = combineWithTails(parts, receiver, value, 3);
  assert.equal(combined.startSeconds, whole.startSeconds);
  assert.equal(combined.channels[0].length, whole.samples.length);
  const peak = whole.peakPa;
  let error = 0;
  whole.channels.forEach((channel, number) => channel.forEach((value, index) => { error = Math.max(error, Math.abs(value - combined.channels[number][index])); }));
  // Float32 rounding of the samples.
  assert.ok(error / peak < 1e-6, `${error / peak}`);
});

test('tail responses made in shares of channels are those made at once', () => {
  const scene = forestBlast({ distance: 400 });
  const value = parseScene({ ...scene, ground: { ...scene.ground, surroundings: true }, render: { ...scene.render, ambisonicOrder: 2 } });
  const receiver = value.receivers[0];
  const whole = tailResponses(receiver, value);
  const shares = joinResponses([[0, 2], [2, 7], [7, 9]].map(channels => tailResponses(receiver, value, channels)));
  assert.equal(shares.forest.length, 9);
  assert.equal(shares.surroundings.length, 9);
  assert.deepEqual(shares, whole);
});

test('a sparser forest drives less of the tail and muffles less under its canopy', () => {
  const render = density => {
    const scene = plainScene('blast');
    scene.ground = { ...scene.ground, forest: true, forestDensity: density };
    scene.render.ambisonicOrder = 0;
    return renderReceiver(prepareScene(scene), scene.receivers[0], scene);
  };
  const peak = result => result.channels[0].reduce((most, value) => Math.max(most, Math.abs(value)), 0);
  const late = result => result.channels[0].reduce((sum, value, index) => (index > result.channels[0].length / 2 ? sum + value * value : sum), 0);
  const [sparse, dense] = [render(.2), render(1)];
  assert.ok(peak(sparse) > peak(dense));
  assert.ok(late(sparse) < late(dense));
});
