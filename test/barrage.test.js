import assert from 'node:assert/strict';
import test from 'node:test';
import { barrageRounds, GROUND_BURST_METRES } from '../src/domain/barrage.js';
import { emitterSources } from '../src/domain/emitters.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultBarrage, defaultScene, parseScene, serializeScene } from '../src/domain/scene.js';

const air = defaultScene('blast').air;

test('a barrage lands its rounds in salvos over its duration, within its radius, from its seed', () => {
  const barrage = { ...defaultBarrage(), roundCount: 30, salvoSize: 6, durationSeconds: 40, salvoSpreadSeconds: 1 };
  const rounds = barrageRounds(barrage);
  assert.equal(rounds.length, 30);
  assert.deepEqual(barrageRounds(barrage), rounds);
  assert.notDeepEqual(barrageRounds({ ...barrage, seed: barrage.seed + 1 }), rounds);
  for (const round of rounds) {
    assert.ok(Math.hypot(round.positionMetres.x - barrage.centreMetres.x, round.positionMetres.y - barrage.centreMetres.y) <= barrage.radiusMetres);
    assert.equal(round.positionMetres.z, GROUND_BURST_METRES);
    assert.ok(round.startSeconds >= 0 && round.startSeconds <= barrage.durationSeconds * 1.2 + barrage.salvoSpreadSeconds);
  }
  // Five salvos: gaps between landings cluster within a salvo and open up between them.
  const gaps = rounds.slice(1).map((round, index) => round.startSeconds - rounds[index].startSeconds);
  assert.equal(gaps.filter(gap => gap > 3).length, 4);
});

test('a barrage keeps its mean charge and bursts its share in the air at its height', () => {
  const rounds = barrageRounds({ ...defaultBarrage(), roundCount: 200, salvoSize: 10, chargeSpread: .5, airburstShare: .25, airburstHeightMetres: 30 });
  const mean = rounds.reduce((sum, round) => sum + round.chargeKilograms, 0) / rounds.length;
  assert.ok(Math.abs(mean / 7 - 1) < .15, `${mean}`);
  const airbursts = rounds.filter(round => round.positionMetres.z === 30).length;
  assert.ok(airbursts > 30 && airbursts < 70, `${airbursts}`);
});

test('every round is a blast with its own shock, secondary shock, and roar', () => {
  const barrage = { ...defaultBarrage(), roundCount: 5, salvoSize: 5 };
  const { sources } = emitterSources(barrage, air);
  assert.equal(sources.length, 15);
  assert.equal(new Set(sources.filter(source => source.pulse === 'noise').map(source => source.noiseSeed)).size, 5);
});

test('a barrage scene round-trips and renders finite sound with one shock per round', () => {
  const scene = defaultScene('blast');
  scene.emitters = [{ ...defaultBarrage(), roundCount: 4, salvoSize: 2, durationSeconds: 6, fireballDecibels: -60, secondaryShock: false }];
  scene.receivers[0].positionMetres = { x: 600, y: 0, z: 1.7 };
  const parsed = parseScene(scene);
  assert.deepEqual(parseScene(JSON.parse(serializeScene(parsed))), parsed);
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  assert.ok(result.samples.every(Number.isFinite));
  const direct = [...result.arrivals.kinds].filter(kind => kind === 0 || kind === 2).length;
  assert.equal(direct, 4);
});
