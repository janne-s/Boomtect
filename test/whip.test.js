import assert from 'node:assert/strict';
import test from 'node:test';
import { WHIP } from '../src/domain/constants.js';
import { carlsonBoom, flightBooms, whipBody, whipPath } from '../src/domain/flight.js';
import { soundSpeedProfile } from '../src/shared/domain/refraction.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultScene, defaultWhip, parseScene, serializeScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';

const whipScene = (whip = {}, receiver = { x: 0, y: 3, z: 1.7 }) => {
  const scene = plainScene('sonic');
  scene.emitters = [{ ...defaultWhip(), ...whip }];
  scene.receivers[0].positionMetres = receiver;
  return parseScene(scene);
};

test('a whip tip reaches its top Mach number after Krehl and Engemann’s 45 cm and is back at Mach 1 20 cm after its turn', () => {
  const scene = whipScene();
  const whip = scene.emitters[0];
  const path = whipPath(whip, scene.air);
  const sound = path.speed.find((_, index) => path.seconds[index] >= whip.startSeconds);
  assert.ok(Math.abs(sound / 343.2 - 1) < .02, `${sound}`);
  const top = Math.max(...path.speed);
  assert.ok(Math.abs(top / sound - whip.mach) < 1e-3, `${top / sound}`);
  // Supersonic for about the measured 1.2 ms (1.4 ms with the turn's half circle).
  const supersonic = path.speed.filter(speed => speed > sound * 1.0001).length * path.step;
  assert.ok(supersonic > 1.2e-3 && supersonic < 1.6e-3, `${supersonic}`);
  // The top speed is reached 45 cm on from where it passed Mach 1.
  const sonicIndex = path.seconds.findIndex(seconds => seconds >= whip.startSeconds);
  const topIndex = path.speed.indexOf(top);
  const along = Math.hypot(path.x[topIndex] - path.x[sonicIndex], path.y[topIndex] - path.y[sonicIndex], path.z[topIndex] - path.z[sonicIndex]);
  assert.ok(Math.abs(along - WHIP.accelerationMetres) < .01, `${along}`);
});

test('a whip’s crack is Carlson’s boom of its cracker where it leaves the path, and a subsonic whip does not crack', () => {
  const scene = whipScene();
  const whip = scene.emitters[0];
  const receiver = { x: -2.75, y: 0, z: 4.6 };
  const booms = flightBooms(whipPath(whip, scene.air), whipBody(whip), receiver, soundSpeedProfile(scene.air), scene.air, { caustics: false });
  const boom = booms.reduce((best, item) => (item.mach > best.mach ? item : best));
  assert.ok(boom.mach > 2 && boom.mach < whip.mach * 1.001, `${booms.map(item => item.mach)}`);
  const pressure = scene.air.pressureKpa * 1000;
  const expected = carlsonBoom({ mach: boom.mach, vehiclePressurePa: pressure, groundPressurePa: pressure, vehicleSoundSpeed: 1, lengthMetres: whip.crackerLengthMetres, shapeFactor: whip.crackerShapeFactor, distanceMetres: boom.ray.metres });
  assert.ok(Math.abs(boom.overpressurePa / expected.overpressurePa - 1) < .01, `${boom.overpressurePa} vs ${expected.overpressurePa}`);
  assert.ok(boom.durationSeconds > 1e-4 && boom.durationSeconds < 5e-4, `${boom.durationSeconds}`);
  const slow = whipScene({ mach: .9 });
  assert.equal(flightBooms(whipPath(slow.emitters[0], slow.air), whipBody(slow.emitters[0]), receiver, soundSpeedProfile(slow.air), slow.air).length, 0);
});

test('a whip renders a crack of finite samples beside it, and its scene round-trips', () => {
  const scene = whipScene();
  const result = renderReceiver(prepareScene(scene), scene.receivers[0], scene);
  assert.ok(result.samples.length > 0 && result.peakPa > 1, `${result.peakPa}`);
  assert.ok(result.samples.every(Number.isFinite));
  assert.deepEqual(parseScene(JSON.parse(serializeScene(scene))), scene);
  const sonic = defaultScene('sonic');
  sonic.emitters.push(defaultWhip('whip-2'));
  assert.doesNotThrow(() => parseScene(sonic));
});
