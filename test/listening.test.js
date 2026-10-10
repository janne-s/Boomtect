import assert from 'node:assert/strict';
import test from 'node:test';
import { composeListening } from '../src/ui/listening.js';
import { defaultScene, parseScene } from '../src/domain/scene.js';

test('playback without the real delay starts at the first sound, not at the render frame before it', () => {
  const scene = parseScene(defaultScene('blast'));
  const sampleRate = 48000;
  // A render whose frame starts 3 s before its only sound.
  const samples = new Float32Array(5 * sampleRate);
  samples[3 * sampleRate] = 100;
  const results = new Map([[scene.receivers[0].id, { receiverId: scene.receivers[0].id, sampleRate, startSeconds: 2, samples, channels: [samples], peakPa: 100 }]]);
  const composition = composeListening(scene, results);
  assert.equal(composition.startSeconds, 2);
  assert.ok(Math.abs(composition.firstSoundSeconds - 5) < 1e-9, `${composition.firstSoundSeconds}`);
});
