import assert from 'node:assert/strict';
import test from 'node:test';
import { PATH_ECHO } from '../src/domain/refraction.js';
import { prepareScene, renderReceiver, resultDifference } from '../src/domain/render.js';
import { parseScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';
import { syntheticTerrain } from './terrain-fixture.js';

test('the terrain echoes alone are a render with them less one without: silent before the first echo, and the two add back up', () => {
  const ridge = (x, y) => 100 + 60 * Math.exp(-(((x - 900) / 120) ** 2));
  const plain = plainScene('blast');
  const base = { ...plain, ground: { ...plain.ground, surroundings: true }, terrain: syntheticTerrain(ridge) };
  const wet = parseScene(base);
  const dry = parseScene({ ...base, ground: { ...base.ground, surroundings: false }, terrain: { ...base.terrain, echoes: false } });
  const withEchoes = renderReceiver(prepareScene(wet), wet.receivers[0], wet);
  const without = renderReceiver(prepareScene(dry), dry.receivers[0], dry);
  const echoes = resultDifference(withEchoes, without);
  const firstEcho = Math.min(...Array.from(withEchoes.arrivals.kinds, (kind, index) => (kind >= PATH_ECHO ? withEchoes.arrivals.seconds[index] : Infinity)));
  const at = (result, seconds) => result.samples[Math.round((seconds - result.startSeconds) * result.sampleRate)] ?? 0;
  let before = 0;
  let after = 0;
  for (let index = 0; index < echoes.samples.length; index += 1) {
    const seconds = echoes.startSeconds + index / echoes.sampleRate;
    if (seconds < firstEcho - .05) before = Math.max(before, Math.abs(echoes.samples[index]));
    else after = Math.max(after, Math.abs(echoes.samples[index]));
    assert.ok(Math.abs(echoes.samples[index] + at(without, seconds) - at(withEchoes, seconds)) < 1e-6 * withEchoes.peakPa);
  }
  // Within 1e-3 of the peak (−60 dB) before the first echo; measured 8e-5.
  assert.ok(before < 1e-3 * withEchoes.peakPa, `${before / withEchoes.peakPa}`);
  assert.ok(after > 100 * before);
  assert.equal(echoes.peakPa, echoes.samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0));
});

test('the share of the timeline without echoes ends as much earlier as the last echo comes after the last other path', async () => {
  const { echoFreeShare } = await import('../src/domain/render.js');
  const result = (startSeconds, seconds, kinds, lengthSeconds) => ({
    startSeconds, sampleRate: 100, samples: new Float32Array(lengthSeconds * 100),
    arrivals: { count: seconds.length, seconds, kinds }
  });
  // Ends at 11 s; its last echo at 9 s, its last other path at 3 s: without echoes it ends at 5 s.
  assert.ok(Math.abs(echoFreeShare(new Map([['a', result(1, [2, 3, 9], [0, 1, PATH_ECHO], 10)]])) - .4) < 1e-12);
  assert.equal(echoFreeShare(new Map([['a', result(1, [2, 3], [0, 1], 10)]])), 1);
});
