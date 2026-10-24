import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { defaultScene } from '../src/domain/scene.js';
import { follower, followerFlight, KIND_PANELS } from '../src/ui/kinds.js';

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

test('a followed rocket keeps its burn time, and its booms after burnout are its slender body\'s, not its plume\'s', async () => {
  const { flightBooms } = await import('../src/domain/flight.js');
  const { followedPath } = await import('../src/shared/domain/follower.js');
  const { parseScene } = await import('../src/domain/scene.js');
  const { soundSpeedProfile } = await import('../src/shared/domain/refraction.js');
  const { FLIGHT } = await import('../src/domain/constants.js');
  const coast = JSON.parse(readFileSync(new URL('./fixtures/salvo-round-coast-path.json', import.meta.url), 'utf8'));
  const flight = followerFlight({ id: 'salvo-1', name: 'Salvo', follow: { role: 'rocket', lengthMetres: 2.87, burnSeconds: 2, paths: [coast] } }, null, options);
  const kept = parseScene({ ...options.scene, emitters: [flight] }).emitters[0];
  assert.equal(kept.follows.burnSeconds, 2);
  const path = followedPath(kept.paths[0]);
  const [dx, dy] = [coast.x.at(-1) - coast.x[0], coast.y.at(-1) - coast.y[0]];
  const receiver = { x: coast.x[0] + 10000 * dx / Math.hypot(dx, dy), y: coast.y[0] + 10000 * dy / Math.hypot(dx, dy), z: 1.7 };
  const air = options.scene.air;
  const after = flightBooms(path, kept, receiver, soundSpeedProfile(air), air).filter(boom => boom.emissionSeconds - path.seconds[0] > 2);
  const plume = flightBooms(path, { ...kept, follows: { ...kept.follows, burnSeconds: undefined } }, receiver, soundSpeedProfile(air), air);
  assert.ok(after.length > 0 && after.every(boom => boom.durationSeconds < .03), after.map(boom => boom.durationSeconds).join());
  assert.ok(plume.every(boom => boom.durationSeconds > .05));
  assert.ok(FLIGHT.coastShapeFactor < kept.shapeFactor);
});

test('a volcano follows the linked Rumbletect volcano\'s crater and onset, its eruption chosen once from the category', async () => {
  const { parseScene, defaultVolcano } = await import('../src/domain/scene.js');
  const scene = defaultScene('blast');
  const ghost = { id: 'volcano-1', name: 'Volcano', follow: { role: 'volcano', crater: { x: -300, y: 20, z: 15 }, startSeconds: 2, category: 'plinian', paths: [] } };
  const context = { partner: 'Rumbletect', uniqueId: base => `${base}-1`, scene };
  const made = follower(ghost, null, context);
  assert.equal(made.kind, 'volcano');
  assert.equal(made.equivalentChargeKilograms, 3.9e5);
  assert.deepEqual(made.positionMetres, { x: -300, y: 20, z: 15 });
  assert.equal(made.startSeconds, 2);
  assert.deepEqual(parseScene({ ...scene, emitters: [made] }).emitters[0].follows, made.follows);
  assert.equal(KIND_PANELS.volcano.followAs(parseScene({ ...scene, emitters: [made] }).emitters[0]), null);
  assert.equal(follower(ghost, null, { ...context, scene: defaultScene('sonic') }), null);
  assert.equal(KIND_PANELS.volcano.followAs(made), null);
  const labels = KIND_PANELS.volcano.macros(made, { onset: true }).map(macro => macro.label);
  assert.ok(labels.includes('Size') && labels.includes('Eruption'));
  assert.ok(!labels.includes('Crater height') && !labels.includes('Onset'));
  assert.ok(!KIND_PANELS.volcano.details(made, { updateEmitter: () => {} }).some(section => section.title === 'Body'));
  const own = { ...defaultVolcano('volcano-2', 'Volcano 2', 1), equivalentChargeKilograms: 4000 };
  assert.deepEqual(KIND_PANELS.volcano.followAs(own), { role: 'volcano', crater: own.positionMetres, startSeconds: 0, eruption: 'vulcanian', paths: [] });
});
