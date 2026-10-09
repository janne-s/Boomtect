import assert from 'node:assert/strict';
import test from 'node:test';
import { speedOfSoundMetresPerSecond } from '../src/domain/air.js';
import {
  blastSources, kinneyGrahamOverpressureRatio, lightningChannelPoints, lightningSources, relaxationRadiusMetres, segmentsFromPoints
} from '../src/domain/emitters.js';
import { defaultBlast, defaultLightning, defaultScene } from '../src/domain/scene.js';

const air = defaultScene().air;

test('a straight channel divides evenly from base to top', () => {
  const points = lightningChannelPoints({ baseMetres: { x: 0, y: 0, z: 0 }, topMetres: { x: 0, y: 0, z: 100 }, segmentLengthMetres: 10, tortuosityDegrees: 0, seed: 1 });
  assert.equal(points.length, 11);
  assert.deepEqual(points.at(-1), { x: 0, y: 0, z: 100 });
  const segments = segmentsFromPoints(points);
  assert.equal(segments[0].arcMetres, 5);
  assert.deepEqual(segments[0].direction, { x: 0, y: 0, z: 1 });
});

test('a tortuous channel is deterministic, reaches its top, and stays above ground', () => {
  const emitter = defaultLightning();
  const first = lightningChannelPoints(emitter);
  const again = lightningChannelPoints(emitter);
  const other = lightningChannelPoints({ ...emitter, seed: emitter.seed + 1 });
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, other);
  assert.deepEqual(first.at(-1), emitter.topMetres);
  assert.ok(first.every(point => point.z >= 0));
  const pathLength = segmentsFromPoints(first).reduce((sum, segment) => sum + segment.lengthMetres, 0);
  const straight = Math.hypot(600, 0, 4000);
  assert.ok(pathLength > straight && pathLength < 1.3 * straight);
});

test('relaxation radius follows sqrt(E / (π p))', () => {
  assert.ok(Math.abs(relaxationRadiusMetres(Math.PI * 101325, 101325) - 1) < 1e-12);
});

test('higher segments radiate lower frequencies through larger relaxation radii', () => {
  const emitter = { ...defaultLightning(), tortuosityDegrees: 0, strokeCount: 1 };
  const { sources } = lightningSources(emitter, air);
  assert.ok(sources.at(-1).spanSeconds > sources[0].spanSeconds);
});

test('emission times follow the return stroke and the stroke interval', () => {
  const emitter = { ...defaultLightning(), tortuosityDegrees: 0, strokeCount: 2, strokeIntervalSeconds: .05 };
  const { sources, segmentCount } = lightningSources(emitter, air);
  assert.equal(sources.length, 2 * segmentCount);
  const first = sources[0];
  const length = Math.hypot(600, 4000);
  assert.ok(Math.abs(first.emissionSeconds - length / segmentCount / 2 / emitter.returnStrokeSpeedMetresPerSecond) < 1e-12);
  assert.ok(Math.abs(sources[segmentCount].emissionSeconds - first.emissionSeconds - .05) < 1e-12);
  assert.ok(sources[segmentCount].amplitudePaMetres < first.amplitudePaMetres);
});

test('Kinney–Graham overpressure matches a hand evaluation and decays as 1/Z far out', () => {
  assert.ok(Math.abs(kinneyGrahamOverpressureRatio(20) / .043357 - 1) < 1e-3);
  const ratio = kinneyGrahamOverpressureRatio(500) / kinneyGrahamOverpressureRatio(1000);
  assert.ok(Math.abs(ratio - 2) < .02);
});

test('a blast is one point source at its linearization radius', () => {
  const emitter = defaultBlast();
  const { sources } = blastSources(emitter, air);
  assert.equal(sources.length, 1);
  assert.ok(Math.abs(sources[0].linearRadiusMetres - 20 * Math.cbrt(10)) < 1e-9);
  assert.ok(speedOfSoundMetresPerSecond(air.temperatureCelsius) > 0);
});
