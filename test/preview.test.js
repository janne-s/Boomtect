import assert from 'node:assert/strict';
import test from 'node:test';
import { PREVIEW } from '../src/domain/constants.js';
import { prepareScene, previewScene, renderReceiver } from '../src/domain/render.js';
import { defaultScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';

test('a preview merges the sources of a flash and keeps their acoustic energy', () => {
  const scene = defaultScene('thunder');
  const preview = previewScene(scene);
  assert.equal(scene.render.quality.sourceMerge, 1);
  assert.equal(preview.render.quality.sourceMerge, PREVIEW.sourceMerge);
  assert.equal(preview.render.preview, true);
  const full = prepareScene(scene)[0].sources;
  const merged = prepareScene(preview)[0].sources;
  assert.ok(merged.length < full.length / PREVIEW.sourceMerge * 1.1, `${merged.length} of ${full.length}`);
  const energy = sources => Array.from({ length: sources.length }, (_, index) => sources.amplitudePaMetres[index] ** 2 * sources.durationSeconds[index]).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(energy(merged) / energy(full) - 1) < 1e-9);
});

test('a preview sounds about as loud and as long as the full render', () => {
  const scene = plainScene('thunder');
  scene.render.ambisonicOrder = 0;
  const level = value => {
    const result = renderReceiver(prepareScene(value), value.receivers[0], value);
    let energy = 0;
    for (const sample of result.channels[0]) energy += sample * sample;
    return { energy, seconds: result.channels[0].length / value.render.sampleRate };
  };
  const full = level(scene);
  const preview = level(previewScene(scene));
  assert.ok(Math.abs(10 * Math.log10(preview.energy / full.energy)) < 1.5);
  assert.ok(Math.abs(preview.seconds - full.seconds) < 1);
});
