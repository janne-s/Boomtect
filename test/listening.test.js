import assert from 'node:assert/strict';
import test from 'node:test';
import { composeListening } from '../src/shared/ui/listening.js';
import { defaultScene, parseScene } from '../src/domain/scene.js';

test('playback without the real delay starts at the first sound, not at the render frame before it', () => {
  const blast = defaultScene('blast');
  const scene = parseScene({ ...blast, receivers: [{ ...blast.receivers[0], type: 'omni' }] });
  const sampleRate = 48000;
  const samples = new Float32Array(5 * sampleRate);
  samples[3 * sampleRate] = 100;
  const results = new Map([[scene.receivers[0].id, { receiverId: scene.receivers[0].id, sampleRate, startSeconds: 2, samples, channels: [samples], peakPa: 100 }]]);
  const composition = composeListening(scene, results);
  assert.equal(composition.startSeconds, 2);
  assert.ok(Math.abs(composition.firstSoundSeconds - 5) < 1e-9, `${composition.firstSoundSeconds}`);
});

test('a listening microphone that hears nothing plays silence beside one that hears the sound', () => {
  const scene = defaultScene('sonic');
  scene.receivers = [{ ...scene.receivers[0], id: 'a', name: 'A', type: 'omni' }, { ...scene.receivers[0], id: 'b', name: 'B', type: 'omni', positionMetres: { x: 5000, y: 0, z: 1.7 } }];
  const parsed = parseScene(scene);
  const sampleRate = 48000;
  const samples = new Float32Array(sampleRate);
  samples[100] = 50;
  const silent = new Float32Array(0);
  const results = new Map([
    ['a', { receiverId: 'a', sampleRate, startSeconds: 12, samples, channels: [samples], peakPa: 50 }],
    ['b', { receiverId: 'b', sampleRate, startSeconds: 0, samples: silent, channels: [silent], peakPa: 0 }]
  ]);
  const composition = composeListening(parsed, results);
  assert.equal(composition.kind, 'pair');
  assert.equal(composition.startSeconds, 12);
  assert.equal(composition.length, sampleRate);
  assert.equal(composition.omnis[0].channel[100], 50);
  assert.ok(composition.omnis[1].channel.every(value => value === 0));
  assert.equal(composeListening(parsed, new Map([['a', results.get('b')], ['b', results.get('b')]])), null);
});
