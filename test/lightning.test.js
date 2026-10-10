import assert from 'node:assert/strict';
import test from 'node:test';
import { speedOfSoundMetresPerSecond } from '../src/domain/air.js';
import { blastSources, emitterSources, kinneyGrahamOverpressureRatio } from '../src/domain/emitters.js';
import { lightningEmitterFlashes, relaxationRadiusMetres, segmentsFromPoints, tortuousPath, weakShockPulse } from '../src/domain/lightning.js';
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

test('a ground flash is deterministic, reaches its top, and branches in levels above the ground', () => {
  const emitter = { ...defaultLightning(), strokeCount: 1, inCloudLengthMetres: 0 };
  const [flash] = lightningEmitterFlashes(emitter);
  assert.deepEqual(lightningEmitterFlashes(emitter), [flash]);
  assert.notDeepEqual(lightningEmitterFlashes({ ...emitter, seed: emitter.seed + 1 }), [flash]);
  const [main, ...branches] = flash.channels;
  assert.deepEqual(main.points.at(-1), emitter.topMetres);
  assert.ok(branches.some(branch => branch.level === 1) && branches.some(branch => branch.level === 2));
  for (const branch of branches) {
    assert.ok(branch.points.every(point => point.z >= 0));
    assert.ok(Math.abs(branch.energyScale - emitter.branchEnergyRatio ** branch.level) < 1e-12);
  }
  assert.ok(lightningEmitterFlashes({ ...emitter, branchDepth: 0 })[0].channels.length === 1);
});

test('later strokes follow one route to ground, sometimes through a new ground point', () => {
  const emitter = { ...defaultLightning(), strokeCount: 6, newTerminationProbability: 1 };
  const [flash] = lightningEmitterFlashes(emitter);
  const terminations = flash.channels.filter(channel => channel.termination);
  assert.equal(terminations.length, 5);
  for (const termination of terminations) assert.equal(termination.points[0].z, 0);
  for (const stroke of flash.strokes.slice(1)) assert.equal(stroke.route.length, 2);
  const fixed = lightningEmitterFlashes({ ...emitter, newTerminationProbability: 0, strokeIntervalSpread: 0 })[0];
  assert.ok(fixed.strokes.slice(1).every(stroke => stroke.route.length === 1 && stroke.route[0].channel === 0));
  fixed.strokes.forEach((stroke, index) => assert.ok(Math.abs(stroke.offsetSeconds - index * emitter.strokeIntervalSeconds) < 1e-12));
});

test('the first stroke lights every channel and later strokes only their route', () => {
  const emitter = { ...defaultLightning(), strokeCount: 2, newTerminationProbability: 0, strokeIntervalSpread: 0, strokeIntervalSeconds: .05 };
  const { flashes, sources } = emitterSources(emitter, air);
  const [flash] = flashes;
  const all = flash.channels.reduce((sum, channel) => sum + channel.segments.length, 0);
  assert.equal(sources.length, all + flash.channels[0].segments.length);
  assert.ok(Math.abs(sources[all].emissionSeconds - sources[0].emissionSeconds - .05) < 1e-12);
});

test('a cloud flash spreads its emission over its length at the channel speed', () => {
  const emitter = { ...defaultCloudFlash(), branchCount: 0, strokeCount: 1, tortuosityDegrees: 0, macroTortuosityDegrees: 0 };
  const { sources } = emitterSources(emitter, air);
  const spread = Math.max(...sources.map(source => source.emissionSeconds)) - Math.min(...sources.map(source => source.emissionSeconds));
  const length = Math.hypot(5000, 1000, 1000);
  assert.ok(Math.abs(spread - (length - emitter.segmentLengthMetres) / emitter.channelSpeedMetresPerSecond) < 1e-3);
});

test('the source period follows Few and ReVelle, grows with distance, and freezes at the weak-shock limit', () => {
  const emitter = { ...defaultLightning(), tortuosityDegrees: 0, macroTortuosityDegrees: 0, branchCount: 0, energyVariation: 0, strokeCount: 1, currentDecayHeightMetres: 1e6, inCloudLengthMetres: 0 };
  const { sources } = emitterSources(emitter, air);
  const low = sources[0].weakShock;
  assert.ok(sources.at(-1).weakShock.relaxationRadius > low.relaxationRadius);
  assert.ok(Math.abs(relaxationRadiusMetres(Math.PI * 101325, 101325) - 1) < 1e-12);
  const near = weakShockPulse(1, .01, 10, 1e4);
  const far = weakShockPulse(1, .01, 160, 1e4);
  assert.ok(Math.abs(far.durationSeconds / near.durationSeconds - 2) < 1e-3);
  assert.ok(Math.abs(far.amplitudeScale - .5) < 1e-9);
  assert.deepEqual(weakShockPulse(1, .01, 1e6, 1e4), weakShockPulse(1, .01, 1e4, 1e4));
  assert.deepEqual(weakShockPulse(1, .01, 2, 1e4), near);
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

test('a blast is its shock, a secondary shock of 4 % of the charge, and a roar, at its linearization radius and onset', () => {
  const sources = blastSources({ ...defaultBlast(), startSeconds: 2 }, air);
  assert.deepEqual(sources.map(source => source.pulse), ['friedlander', 'friedlander', 'noise']);
  assert.ok(sources.every(source => source.emissionSeconds === 2));
  assert.ok(Math.abs(sources[0].linearRadiusMetres - 20 * Math.cbrt(10)) < 1e-9);
  // A smaller charge's shock: amplitude and duration scale with the cube root of the share.
  assert.ok(Math.abs(sources[1].amplitudePaMetres / sources[0].amplitudePaMetres - Math.cbrt(.04)) < 1e-9);
  assert.ok(Math.abs(sources[2].amplitudePaMetres / sources[0].amplitudePaMetres - .1) < 1e-9);
  assert.equal(blastSources({ ...defaultBlast(), secondaryShock: false, fireballDecibels: -60 }, air).length, 1);
  assert.ok(speedOfSoundMetresPerSecond(air.temperatureCelsius) > 0);
});

test('return-stroke energy falls as e^(−2z/λ) with height, and in-cloud channels start at the top after the stroke', async () => {
  const { emissionSeconds } = await import('../src/domain/lightning.js');
  const base = { ...defaultLightning(), topMetres: { x: 0, y: 0, z: 3000 }, tortuosityDegrees: 0, macroTortuosityDegrees: 0, branchCount: 0, energyVariation: 0, strokeCount: 1 };
  const flat = emitterSources({ ...base, currentDecayHeightMetres: 1e6, inCloudLengthMetres: 0 }, air).sources;
  const decaying = emitterSources({ ...base, currentDecayHeightMetres: 2000, inCloudLengthMetres: 0 }, air).sources;
  for (const index of [0, 100, flat.length - 1]) {
    const z = flat[index].positionMetres.z;
    const expected = Math.exp(-2 * z / 2000);
    const energy = source => (source.weakShock.relaxationRadius ** 2);
    // R₀² ∝ E at a given height, so the ratio of squared radii is the energy share.
    assert.ok(Math.abs(energy(decaying[index]) / energy(flat[index]) / (expected / Math.exp(-2 * z / 1e6)) - 1) < 1e-9);
  }
  const [flash] = lightningEmitterFlashes({ ...base, inCloudLengthMetres: 4000 });
  const inCloud = flash.channels.filter(channel => channel.inCloud);
  assert.equal(inCloud.length, 2);
  const mainLength = flash.channels[0].arcs?.at(-1) ?? flash.channels[0].segments.at(-1).arcMetres;
  for (const channel of inCloud) {
    assert.deepEqual(channel.points[0], base.topMetres);
    assert.ok(Math.abs(channel.points.at(-1).z - base.topMetres.z) < 4000 * Math.sin(10 * Math.PI / 180) + 1);
  }
  const step = flash.strokes[0].route.find(entry => flash.channels[entry.channel].inCloud);
  const start = emissionSeconds(flash, flash.strokes[0], step, 0);
  assert.ok(start >= mainLength / base.channelSpeedMetresPerSecond * .99);
  assert.ok(Math.abs(emissionSeconds(flash, flash.strokes[0], step, 3000) - start - 3000 / base.inCloudSpeedMetresPerSecond) < 1e-12);
  assert.equal(lightningEmitterFlashes({ ...base, flashType: 'intra-cloud', baseMetres: { x: 0, y: 0, z: 2000 }, inCloudLengthMetres: 4000 })[0].channels.filter(channel => channel.inCloud).length, 0);
});
