import assert from 'node:assert/strict';
import test from 'node:test';
import { flightBooms } from '../src/domain/flight.js';
import { defaultFlight, defaultScene, parseScene } from '../src/domain/scene.js';
import { soundSpeedProfile } from '../src/shared/domain/refraction.js';
import { flightPath, withApproach } from '../src/shared/domain/trajectory.js';

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
