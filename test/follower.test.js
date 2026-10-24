import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { defaultScene } from '../src/domain/scene.js';
import { followerFlight, KIND_PANELS } from '../src/ui/kinds.js';

const saved = JSON.parse(readFileSync(new URL('./fixtures/salvo-round-path.json', import.meta.url), 'utf8'));
const ghost = lengthMetres => ({ id: 'salvo-1', name: 'Salvo', follow: { role: 'rocket', lengthMetres, paths: [saved] } });
const options = { partner: 'Rumbletect', uniqueId: base => `${base}-1`, scene: defaultScene('sonic') };

test('a followed rocket takes its length from the linked tect, and again when it changes', () => {
  const first = followerFlight(ghost(2.87), null, options);
  assert.equal(first.body, 'rocket');
  assert.equal(first.lengthMetres, 2.87);
  assert.equal(followerFlight(ghost(70), first, options).lengthMetres, 70);
  assert.equal(followerFlight(ghost(undefined), null, options).lengthMetres, 104.5);
  assert.match(KIND_PANELS.flight.summary(first, options.scene), /^2\.9 m rocket on Rumbletect's Salvo/);
});
