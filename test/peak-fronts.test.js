import assert from 'node:assert/strict';
import test from 'node:test';
import { envelopePeaks, peakFronts } from '../src/domain/peak-fronts.js';
import { pathProfile, soundSpeedProfile, travelSeconds } from '../src/domain/refraction.js';
import { prepareScene, receiverPaths, renderReceiver } from '../src/domain/render.js';
import { defaultScene, parseScene } from '../src/domain/scene.js';

const RATE = 48000;

test('envelope peaks are the swells within range that stand above their dips, loudest first', () => {
  // A burst at 1 s, one half as strong (−6 dB) at 3 s, a ripple on its tail too small to count, and one 30 dB down at 5 s.
  const samples = new Float32Array(6 * RATE);
  const burst = (at, amplitude, seconds = .3) => {
    for (let index = 0; index < seconds * RATE; index += 1) samples[Math.round(at * RATE) + index] += amplitude * Math.sin(index * .3) * Math.exp(-index / (.1 * RATE));
  };
  burst(1, 1);
  burst(1.12, .05);
  burst(3, .5);
  burst(5, .03);
  const peaks = envelopePeaks(samples, 10, RATE);
  assert.equal(peaks.length, 2);
  assert.ok(Math.abs(peaks[0].seconds - 11.05) < .1, `${peaks[0].seconds}`);
  assert.equal(peaks[0].decibels, 0);
  assert.ok(Math.abs(peaks[1].seconds - 13.05) < .1, `${peaks[1].seconds}`);
  assert.ok(Math.abs(peaks[1].decibels + 6) < 1, `${peaks[1].decibels}`);
});

test('the default flash swells from several heights of its channel, each front reaching the microphone at its peak', () => {
  const scene = parseScene(defaultScene('thunder'));
  const prepared = prepareScene(scene);
  const receiver = scene.receivers[0];
  const result = renderReceiver(prepared, receiver, scene);
  const fronts = peakFronts(prepared, receiverPaths(prepared, receiver, scene), result, receiver, scene);
  const peaks = envelopePeaks(result.samples, result.startSeconds, result.sampleRate);
  assert.ok(fronts.length >= 2, `${fronts.length}`);
  assert.equal(fronts[0].decibels, 0);
  const heights = fronts.map(front => front.point.z);
  assert.ok(Math.max(...heights) - Math.min(...heights) > 300, `${heights}`);
  const profile = soundSpeedProfile(scene.air);
  fronts.forEach((front, index) => {
    const arrival = front.emittedSeconds + travelSeconds(pathProfile(profile, front.point, receiver.positionMetres), front.point, receiver.positionMetres);
    assert.ok(Math.abs(arrival - peaks[index].seconds) < 1e-9);
    // Within the flash's few tenths of a second of strokes, give or take the centre's own travel time.
    assert.ok(front.emittedSeconds > -.5 && front.emittedSeconds < 1, `${front.emittedSeconds}`);
  });
});

test('a blast sends no swelling fronts', () => {
  const scene = parseScene(defaultScene('blast'));
  const prepared = prepareScene(scene);
  const receiver = scene.receivers[0];
  assert.deepEqual(peakFronts(prepared, receiverPaths(prepared, receiver, scene), renderReceiver(prepared, receiver, scene), receiver, scene), []);
});
