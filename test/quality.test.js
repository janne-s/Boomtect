import assert from 'node:assert/strict';
import test from 'node:test';
import { fft, nextPowerOfTwo } from '../src/domain/fft.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { DEFAULT_QUALITY, defaultScene, parseScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';

test('a scene carries its computation, at the fullest by default, and checks it', () => {
  const scene = defaultScene('thunder');
  assert.deepEqual(parseScene(scene).render.quality, { ...DEFAULT_QUALITY });
  assert.throws(() => parseScene({ ...scene, render: { ...scene.render, quality: { ...DEFAULT_QUALITY, sourceMerge: 2.5 } } }));
  assert.throws(() => parseScene({ ...scene, render: { ...scene.render, quality: { ...DEFAULT_QUALITY, highestFrequencyHz: 500 } } }));
});

test('the quality merges sources and stops the sound at its highest frequency', () => {
  const full = plainScene('thunder');
  full.render.ambisonicOrder = 0;
  const light = structuredClone(full);
  light.render.quality = { ...DEFAULT_QUALITY, sourceMerge: 2, highestFrequencyHz: 1000 };
  assert.ok(prepareScene(light)[0].sources.length < prepareScene(full)[0].sources.length * .6);
  const above = scene => {
    const samples = renderReceiver(prepareScene(scene), scene.receivers[0], scene).channels[0];
    const size = nextPowerOfTwo(samples.length);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    re.set(samples);
    fft(re, im);
    let high = 0;
    let all = 0;
    for (let bin = 1; bin < size / 2; bin += 1) {
      const energy = re[bin] ** 2 + im[bin] ** 2;
      all += energy;
      if (bin * scene.render.sampleRate / size > 1500) high += energy;
    }
    return high / all;
  };
  assert.ok(above(light) < above(full) / 100);
});
