import assert from 'node:assert/strict';
import test from 'node:test';
import { fft, nextPowerOfTwo } from '../src/shared/domain/fft.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { DEFAULT_QUALITY, defaultScene, parseScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';
import { syntheticTerrain } from './terrain-fixture.js';

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

test('a coarse forest sounds as the full one, and shared scatter keeps the echoes\' energy', () => {
  const run = (quality, terrain = null) => {
    const scene = defaultScene('thunder');
    scene.render.ambisonicOrder = 0;
    if (terrain) scene.terrain = terrain;
    Object.assign(scene.render.quality, quality);
    return renderReceiver(prepareScene(scene), scene.receivers[0], scene).channels[0];
  };
  const full = run({});
  const coarse = run({ coarseForest: true });
  let energy = 0;
  let difference = 0;
  for (let index = 0; index < full.length; index += 1) { energy += full[index] ** 2; difference += (full[index] - coarse[index]) ** 2; }
  assert.ok(10 * Math.log10(difference / energy) < -60, `${10 * Math.log10(difference / energy)} dB`);
  const hills = syntheticTerrain((x, y) => 100 + 120 * Math.sin(x / 900) * Math.cos(y / 700), { extentMetres: 8000, cells: 160 });
  const total = samples => samples.reduce((sum, value) => sum + value * value, 0);
  const own = total(run({}, hills));
  const shared = total(run({ sharedScatter: true }, hills));
  assert.ok(Math.abs(10 * Math.log10(shared / own)) < .5, `${10 * Math.log10(shared / own)} dB`);
  assert.throws(() => parseScene({ ...defaultScene('thunder'), render: { ...defaultScene('thunder').render, quality: { ...DEFAULT_QUALITY, sharedScatter: 1 } } }));
});
