import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultScene, readScene, sceneInMode, serializeScene } from '../src/domain/scene.js';
import { syntheticTerrain } from './terrain-fixture.js';

test('mode changes carry place and terrain while preserving each mode’s source scene', () => {
  const thunder = defaultScene('thunder');
  thunder.terrain = syntheticTerrain((x, y) => 100 + x / 100 + y / 200);
  const original = structuredClone(thunder);
  const sonic = defaultScene('sonic');
  sonic.place = { name: 'Elsewhere', latitude: 0, longitude: 0 };
  const next = sceneInMode(thunder, sonic);
  assert.equal(next.mode, 'sonic');
  assert.deepEqual(next.emitters, sonic.emitters);
  assert.deepEqual(next.place, thunder.place);
  assert.deepEqual(next.terrain, thunder.terrain);
  assert.deepEqual(readScene(JSON.parse(serializeScene(next))), next);
  assert.deepEqual(thunder, original);
  next.terrain.enabled = false;
  assert.equal(thunder.terrain.enabled, true);
  const blast = sceneInMode(next, defaultScene('blast'));
  assert.deepEqual(blast.terrain, next.terrain);
  next.terrain = null;
  assert.equal(sceneInMode(next, thunder).terrain, null);
});
