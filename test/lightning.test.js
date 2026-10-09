import assert from 'node:assert/strict';
import test from 'node:test';
import { speedOfSoundMetresPerSecond } from '../src/domain/air.js';
import { blastSources, emitterSources, kinneyGrahamOverpressureRatio } from '../src/domain/emitters.js';
import { lightningEmitterFlashes, relaxationRadiusMetres, segmentsFromPoints, tortuousPath } from '../src/domain/lightning.js';
import { createRandom } from '../src/domain/random.js';
import { defaultBlast, defaultCloudFlash, defaultLightning, defaultScene, defaultStorm } from '../src/domain/scene.js';
import { stormFlashes } from '../src/domain/storm.js';

const air = defaultScene().air;
const channelLength = channel => channel.segments.reduce((sum, segment) => sum + segment.lengthMetres, 0);

test('a straight path divides evenly from start to end', () => {
  const points = tortuousPath(createRandom(1), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 100 }, 10, 0);
  assert.equal(points.length, 11);
  const segments = segmentsFromPoints(points);
  assert.equal(segments[0].arcMetres, 5);
  assert.deepEqual(segments[0].direction, { x: 0, y: 0, z: 1 });
});

test('a ground flash is deterministic, reaches its top, and branches downward above the ground', () => {
  const emitter = defaultLightning();
  const [flash] = lightningEmitterFlashes(emitter);
  assert.deepEqual(lightningEmitterFlashes(emitter), [flash]);
  assert.notDeepEqual(lightningEmitterFlashes({ ...emitter, seed: emitter.seed + 1 }), [flash]);
  const [main, ...branches] = flash.channels;
  assert.deepEqual(main.points.at(-1), emitter.topMetres);
  assert.ok(channelLength(main) < 1.3 * Math.hypot(600, 4000));
  assert.ok(branches.length > 0 && branches.length <= emitter.branchCount);
  for (const branch of branches) {
    assert.ok(branch.points.every(point => point.z >= 0));
    assert.ok(branch.points.at(-1).z < branch.points[0].z);
    assert.equal(branch.energyScale, emitter.branchEnergyRatio);
  }
});

test('later strokes follow the main channel only and start at their interval', () => {
  const emitter = { ...defaultLightning(), strokeCount: 2, strokeIntervalSeconds: .05 };
  const { flashes, sources } = emitterSources(emitter, air);
  const [flash] = flashes;
  const all = flash.channels.reduce((sum, channel) => sum + channel.segments.length, 0);
  const main = flash.channels[0].segments.length;
  assert.equal(sources.length, all + main);
  const firstMain = sources[0];
  const secondMain = sources[all];
  assert.ok(Math.abs(secondMain.emissionSeconds - firstMain.emissionSeconds - .05) < 1e-12);
});

test('a cloud flash spreads its emission over its length at the channel speed', () => {
  const emitter = { ...defaultCloudFlash(), branchCount: 0, strokeCount: 1, tortuosityDegrees: 0 };
  const { sources } = emitterSources(emitter, air);
  const spread = Math.max(...sources.map(source => source.emissionSeconds)) - Math.min(...sources.map(source => source.emissionSeconds));
  const length = Math.hypot(5000, 1000, 1000);
  assert.ok(Math.abs(spread - (length - emitter.segmentLengthMetres) / emitter.channelSpeedMetresPerSecond) < 1e-3);
});

test('lower energy and higher altitude change the pulse as Few predicts', () => {
  const emitter = { ...defaultLightning(), tortuosityDegrees: 0, branchCount: 0, energyVariation: 0, strokeCount: 1 };
  const { sources } = emitterSources(emitter, air);
  assert.ok(sources.at(-1).durationSeconds > sources[0].durationSeconds);
  const weaker = emitterSources({ ...emitter, energyJoulesPerMetre: emitter.energyJoulesPerMetre / 4 }, air).sources;
  assert.ok(Math.abs(weaker[0].durationSeconds / sources[0].durationSeconds - .5) < 1e-9);
  assert.ok(Math.abs(relaxationRadiusMetres(Math.PI * 101325, 101325) - 1) < 1e-12);
});

test('a storm is deterministic and keeps its flashes inside its disc, window, and cloud layer', () => {
  const storm = defaultStorm();
  const flashes = stormFlashes(storm);
  assert.deepEqual(stormFlashes(storm), flashes);
  assert.equal(flashes.length, storm.flashCount);
  for (const flash of flashes) {
    assert.ok(flash.startSeconds >= storm.startSeconds && flash.startSeconds <= storm.startSeconds + storm.durationSeconds);
    const base = flash.channels[0].points[0];
    if (flash.type === 'cloud-to-ground') {
      assert.equal(base.z, 0);
      assert.ok(Math.hypot(base.x, base.y) <= storm.radiusMetres + 1e-6);
    } else {
      const [first, last] = [flash.channels[0].points[0], flash.channels[0].points.at(-1)];
      for (const point of [first, last]) assert.ok(point.z >= storm.cloudBaseMetres && point.z <= storm.cloudTopMetres);
    }
  }
  assert.ok(stormFlashes({ ...storm, groundFlashShare: 1 }).every(flash => flash.type === 'cloud-to-ground'));
  assert.ok(stormFlashes({ ...storm, groundFlashShare: 0 }).every(flash => flash.type === 'intra-cloud'));
});

test('Kinney–Graham overpressure matches a hand evaluation and decays as 1/Z far out', () => {
  assert.ok(Math.abs(kinneyGrahamOverpressureRatio(20) / .043357 - 1) < 1e-3);
  assert.ok(Math.abs(kinneyGrahamOverpressureRatio(500) / kinneyGrahamOverpressureRatio(1000) - 2) < .02);
});

test('a blast is one point source at its linearization radius and onset', () => {
  const sources = blastSources({ ...defaultBlast(), startSeconds: 2 }, air);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].emissionSeconds, 2);
  assert.ok(Math.abs(sources[0].linearRadiusMetres - 20 * Math.cbrt(10)) < 1e-9);
  assert.ok(speedOfSoundMetresPerSecond(air.temperatureCelsius) > 0);
});
