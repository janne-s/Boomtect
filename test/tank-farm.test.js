import assert from 'node:assert/strict';
import test from 'node:test';
import { emitterSources } from '../src/domain/emitters.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { SOURCE_KINDS } from '../src/domain/sources.js';
import { defaultTankFarm, parseScene, readScene, serializeScene } from '../src/domain/scene.js';
import { openingExplosion, openingSeed, tankFarmLayout, tankFarmRounds, tankFarmTanks } from '../src/domain/tank-farm.js';
import { combustionSamples } from '../src/domain/gas-explosion.js';
import { fireballRoarSamples } from '../src/domain/bleve.js';
import { plainScene } from './plain-scene.js';

const STANDARD_AIR = { pressureKpa: 101.325, temperatureCelsius: 15 };
const even = { ...defaultTankFarm(), heatingSpread: 0, otherShare: 0 };

test('a tank farm opens in Blast mode, reads unknown vessels as defaults, and its scene round-trips', () => {
  const scene = plainScene('blast');
  scene.emitters = [{ ...defaultTankFarm(), vessel: 'barrel' }];
  const value = readScene(JSON.parse(JSON.stringify(scene)));
  assert.equal(value.emitters[0].vessel, 'homeTank');
  assert.deepEqual(readScene(JSON.parse(serializeScene(value))), value);
});

test('the tanks stand in rows centred on the farm, turned with its heading', () => {
  const positions = tankFarmLayout({ ...defaultTankFarm(), tankCount: 6, spacingMetres: 10, centreMetres: { x: 100, y: 50, z: 0 } });
  assert.equal(positions.length, 6);
  const mean = positions.reduce((sum, point) => ({ x: sum.x + point.x / 6, y: sum.y + point.y / 6 }), { x: 0, y: 0 });
  assert.ok(Math.abs(mean.x - 100) < 1e-9 && Math.abs(mean.y - 50) < 1e-9);
  assert.ok(Math.abs(Math.hypot(positions[1].x - positions[0].x, positions[1].y - positions[0].y) - 10) < 1e-9);
  const turned = tankFarmLayout({ ...defaultTankFarm(), tankCount: 6, spacingMetres: 10, headingDegrees: 90 });
  const straight = tankFarmLayout({ ...defaultTankFarm(), tankCount: 6, spacingMetres: 10 });
  assert.ok(Math.abs(turned[3].x - straight[3].y) < 1e-9 && Math.abs(turned[3].y + straight[3].x) < 1e-9);
});

test('the fire reaches the tanks from the first one, which fails at the start, and a fireball nearby hurries the next', () => {
  const far = { ...even, spacingMetres: 200 };
  const tanks = tankFarmTanks(far);
  const first = tanks.find(tank => tank.id.endsWith(':0'));
  assert.equal(tanks[0], first);
  assert.ok(Math.abs(first.startSeconds - far.startSeconds) < 1e-9);
  const second = tanks.find(tank => tank.id.endsWith(':1'));
  assert.ok(Math.abs(second.startSeconds - far.startSeconds - 200 / far.spreadMetresPerSecond) < 1e-9);
  const near = tankFarmTanks({ ...even, spacingMetres: 10 });
  const hurried = near.find(tank => tank.id.endsWith(':1'));
  assert.ok(Math.abs(hurried.startSeconds - even.startSeconds - .5 * 10 / even.spreadMetresPerSecond) < 1e-9);
  const opened = tankFarmTanks({ ...far, openingCloudCubicMetres: 2000 });
  assert.ok(Math.abs(opened[0].startSeconds - far.startSeconds - far.heatingSeconds) < 1e-9);
});

test('a tank is hurried once, so a dense farm of small tanks does not fail all at once', () => {
  const dense = { ...defaultTankFarm(), vessel: 'cylinder47', otherVessel: 'cylinder47', fluid: 'gasoline', tankCount: 60, spacingMetres: 2, heatingSeconds: 10 };
  const times = tankFarmTanks(dense).map(tank => tank.startSeconds);
  const together = times.slice(1).filter((time, index) => time - times[index] < 1e-3).length;
  assert.ok(together < 3, `${together} tanks within 1 ms of the one before`);
});

test('the mix takes the other vessel by its share', () => {
  assert.ok(tankFarmTanks({ ...defaultTankFarm(), otherShare: 0 }).every(tank => tank.vesselCubicMetres === 2));
  assert.ok(tankFarmTanks({ ...defaultTankFarm(), otherShare: 1 }).every(tank => tank.vesselCubicMetres === 40));
});

test('an opening cloud explodes at the first tank when the farm is set and its fuel burns', () => {
  assert.equal(openingExplosion(defaultTankFarm()), null);
  const farm = { ...defaultTankFarm(), openingCloudCubicMetres: 2000 };
  const opening = openingExplosion(farm);
  assert.deepEqual(opening.positionMetres, tankFarmLayout(farm)[0]);
  assert.equal(opening.startSeconds, farm.startSeconds);
  assert.equal(tankFarmRounds(farm)[0].kind, 'gasExplosion');
  assert.equal(openingExplosion({ ...farm, fluid: 'water' }), null);
  const noise = SOURCE_KINDS.tankFarm.noise;
  assert.deepEqual(noise(openingSeed(farm), .5, 8000, farm), combustionSamples(openingSeed(farm), .5, 8000, opening));
  assert.deepEqual(noise(12345, .5, 8000, farm), fireballRoarSamples(12345, .5, 8000));
});

test('a small farm renders finite, its bangs and roars from every tank', () => {
  const farm = { ...defaultTankFarm(), tankCount: 3, spacingMetres: 40, heatingSeconds: 2, openingCloudCubicMetres: 500 };
  assert.equal(emitterSources(farm, STANDARD_AIR).sources.length, 3 * 3 + 2);
  const scene = plainScene('blast');
  scene.emitters = [farm];
  scene.receivers[0].positionMetres = { x: 300, y: 0, z: 1.7 };
  const value = parseScene(scene);
  const { samples } = renderReceiver(prepareScene(value), value.receivers[0], value);
  assert.ok(samples.every(Number.isFinite));
  assert.ok(samples.some(sample => Math.abs(sample) > 1));
});
