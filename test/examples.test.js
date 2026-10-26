import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { readScene } from '../src/domain/scene.js';

const folder = new URL('../examples/', import.meta.url);

test('every example scene reads with the fields it names kept', () => {
  for (const file of readdirSync(folder).filter(name => name.endsWith('.json'))) {
    const written = JSON.parse(readFileSync(new URL(file, folder), 'utf8'));
    const scene = readScene(written);
    assert.equal(scene.mode, written.mode, file);
    assert.deepEqual(scene.emitters.map(emitter => emitter.kind), written.emitters.map(emitter => emitter.kind), file);
    assert.deepEqual(scene.receivers.map(receiver => receiver.positionMetres), written.receivers.map(receiver => receiver.positionMetres), file);
    assert.equal(scene.ground.type, written.ground.type, file);
  }
});
