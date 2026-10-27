import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { flightBooms } from '../src/domain/flight.js';
import { defaultFlight, defaultScene, parseScene } from '../src/domain/scene.js';
import { soundSpeedProfile } from '../src/shared/domain/refraction.js';
import { flightPath, withApproach } from '../src/shared/domain/trajectory.js';
import { followedPath } from '../src/shared/domain/follower.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';

const scene = parseScene(defaultScene('sonic'));
const profile = soundSpeedProfile(scene.air);
const accelerating = { ...defaultFlight(), startMetres: { x: -2500, y: 0, z: 5500 }, headingDegrees: 90, climbDegrees: 0, mach: .93, accelerationMetresPerSecondSquared: 1.5, turnDegreesPerSecond: 0, durationSeconds: 156 };
const booms = receiver => flightBooms(withApproach(flightPath(accelerating, scene.air), scene.air), accelerating, receiver, profile, scene.air);
const arrival = boom => boom.emissionSeconds + boom.ray.seconds;

test('past the fold of an accelerating flight two booms arrive: an N-wave, then the turned U-wave', () => {
  const found = booms({ x: 29000, y: -3100, z: 1.7 }).sort((a, b) => arrival(a) - arrival(b));
  assert.equal(found.length, 2);
  assert.ok(!found[0].hilbert && found[1].hilbert && !found[0].focusMu && !found[1].focusMu);
  assert.ok(arrival(found[1]) - arrival(found[0]) > .1);
});

test('nearer the fold the two become one focused boom, and a level steady flight has none', () => {
  let focused = null;
  for (let x = 2000; x <= 30000 && !focused; x += 250) {
    const found = booms({ x, y: -3100, z: 1.7 });
    const boom = found.find(item => item.focusMu > 0);
    if (boom) focused = { found, boom };
  }
  assert.ok(focused);
  assert.ok(focused.boom.focusMu > 1e-3 && focused.boom.focusMu < 10);
  assert.ok(focused.found.every(item => item === focused.boom || !item.hilbert));
  const steady = { ...accelerating, mach: 1.6, accelerationMetresPerSecondSquared: 0 };
  const plain = flightBooms(withApproach(flightPath(steady, scene.air), scene.air), steady, { x: 9000, y: -3100, z: 1.7 }, profile, scene.air);
  assert.equal(plain.length, 1);
  assert.ok(!plain[0].hilbert && !plain[0].focusMu);
});

test('a salvo round climbing away, whose cone never reaches the microphone, gives no boom though its slope has a minimum', () => {
  const saved = JSON.parse(readFileSync(new URL('./fixtures/salvo-round-path.json', import.meta.url), 'utf8'));
  const body = { lengthMetres: 104.5, shapeFactor: .68 };
  assert.deepEqual(flightBooms(followedPath(saved), body, { x: saved.x[0] + 1400, y: saved.y[0], z: 1.7 }, profile, scene.air), []);
});

test('a giant fast round without the source history for a focused wave keeps its causal first shock', () => {
  const saved = JSON.parse(readFileSync(new URL('./fixtures/mega-salvo-round-path.json', import.meta.url), 'utf8'));
  const flight = { ...defaultFlight(), body: 'rocket', lengthMetres: 88.7, shapeFactor: .68,
    follows: { app: 'Rumbletect', id: 'salvo-1', name: 'Salvo', burnSeconds: 2 }, paths: [saved] };
  const receiver = { ...scene.receivers[0], positionMetres: { x: 2205, y: 42, z: 1.7 } };
  const found = flightBooms(followedPath(saved), flight, receiver.positionMetres, profile, scene.air);
  assert.equal(found.length, 1);
  assert.ok(!found[0].focusMu && !found[0].hilbert);
  assert.ok(Math.abs(arrival(found[0]) - 6.0431) < .001);
  const parsed = parseScene({ ...scene, ground: { ...scene.ground, enabled: false, forest: false, surroundings: false },
    render: { ...scene.render, ambisonicOrder: 0 }, emitters: [flight], receivers: [receiver] });
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  let earlyPeak = 0;
  let peak = 0;
  for (let index = 0; index < result.samples.length; index += 1) {
    const value = Math.abs(result.samples[index]);
    peak = Math.max(peak, value);
    if (result.startSeconds + index / result.sampleRate < 5.94) earlyPeak = Math.max(earlyPeak, value);
  }
  assert.ok(peak > 0 && Number.isFinite(peak));
  assert.ok(earlyPeak < .01 * peak, `early peak ${earlyPeak}, peak ${peak}`);
});
