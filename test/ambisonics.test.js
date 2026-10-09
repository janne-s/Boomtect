import assert from 'node:assert/strict';
import test from 'node:test';
import { ambisonicDirection, encodeDirection, headingRotation, rotateGains } from '../src/domain/ambisonics.js';

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} vs ${expected}`);

function unitDirection(azimuth, elevation) {
  return [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
}

test('SN3D gains of every degree have unit power in every direction', () => {
  for (const [azimuth, elevation] of [[0, 0], [.7, .3], [-2.1, -.9], [3, 1.2]]) {
    const gains = encodeDirection(...unitDirection(azimuth, elevation), 3);
    for (let n = 0; n <= 3; n += 1) {
      let power = 0;
      for (let m = -n; m <= n; m += 1) power += gains[n * n + n + m] ** 2;
      close(power, 1, `degree ${n}`);
    }
  }
});

test('first-order channels follow ACN: W, Y (left), Z (up), X (front)', () => {
  assert.deepEqual([...encodeDirection(1, 0, 0, 1)], [1, 0, 0, 1]);
  assert.deepEqual([...encodeDirection(0, 1, 0, 1)], [1, 1, 0, 0]);
  assert.deepEqual([...encodeDirection(0, 0, 1, 1)], [1, 0, 1, 0]);
});

test('the world frame puts north in front and west to the left', () => {
  assert.deepEqual(ambisonicDirection(0, 1, 0), [1, -0, 0]);
  assert.deepEqual(ambisonicDirection(-1, 0, 0), [0, 1, 0]);
});

test('a heading rotation equals encoding the turned direction', () => {
  for (const heading of [0, 37, 90, 211]) {
    const terms = headingRotation(heading, 3);
    const azimuth = .4;
    const elevation = .25;
    const rotated = rotateGains(encodeDirection(...unitDirection(azimuth, elevation), 3), terms);
    const expected = encodeDirection(...unitDirection(azimuth + heading * Math.PI / 180, elevation), 3);
    rotated.forEach((value, index) => close(value, expected[index], `heading ${heading}, channel ${index}`));
  }
});

test('facing east brings a source in the east to the front', () => {
  const east = encodeDirection(...ambisonicDirection(1, 0, 0), 1);
  const heard = rotateGains(east, headingRotation(90, 1));
  close(heard[3], 1, 'front');
  close(heard[1], 0, 'left');
});
