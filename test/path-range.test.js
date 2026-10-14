import assert from 'node:assert/strict';
import test from 'node:test';
import { assemblePaths, frameExtents, pathRange, prepareScene, renderReceiverRange, tracePart } from '../src/domain/render.js';
import { defaultScene } from '../src/domain/scene.js';

test('a range of the paths renders as the whole does over the same times', () => {
  const scene = defaultScene('thunder');
  const prepared = prepareScene(scene);
  const receiver = scene.receivers[0];
  const paths = assemblePaths(prepared, receiver, scene, [tracePart(prepared, receiver, scene)]);
  const middle = (paths.seconds.reduce((a, b) => Math.min(a, b), Infinity) + paths.seconds.reduce((a, b) => Math.max(a, b), -Infinity)) / 2;
  const range = pathRange(paths, middle, Infinity);
  assert.ok(range.count > 0 && range.count < paths.count);
  const whole = renderReceiverRange(prepared, receiver, scene, { paths, fromSeconds: middle });
  const part = renderReceiverRange(prepared, receiver, scene, { paths: range, extents: frameExtents(prepared, paths), fromSeconds: middle });
  assert.equal(part.startSample, whole.startSample);
  assert.deepEqual(part.channels, whole.channels);
});
