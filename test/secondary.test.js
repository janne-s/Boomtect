import assert from 'node:assert/strict';
import test from 'node:test';
import { flightMembers, flightPath, withApproach } from '../src/domain/flight.js';
import { prepareScene, receiverPaths } from '../src/domain/render.js';
import { defaultScene } from '../src/domain/scene.js';
import { secondaryBooms, upperTemperatureKelvin } from '../src/domain/secondary.js';

// A Concorde-like flight east at Mach 2 and 17 km for 15 minutes.
const concorde = scene => ({ ...scene.emitters[0], startMetres: { x: -300000, y: 0, z: 17000 }, mach: 2, durationSeconds: 900, body: 'custom', lengthMetres: 62, shapeFactor: .08 });

function booms(air, receiver) {
  const scene = defaultScene('sonic');
  const [member] = flightMembers(concorde(scene));
  return secondaryBooms(withApproach(flightPath(member, air), air), member, receiver, air);
}

test('the upper air warms as the standard atmosphere above the tropopause', () => {
  const { air } = defaultScene('sonic');
  assert.ok(Math.abs(upperTemperatureKelvin(air, 15000) - 216.65) < .01);
  assert.ok(Math.abs(upperTemperatureKelvin(air, 32000) - 228.65) < .01);
  assert.ok(Math.abs(upperTemperatureKelvin(air, 49000) - 270.65) < .01);
  assert.ok(Math.abs(upperTemperatureKelvin(air, 71000) - 214.65) < .01);
});

test('a boom comes back from the stratosphere far downwind of the upper wind, and nowhere without it', () => {
  const { air } = defaultScene('sonic');
  const far = { x: 0, y: 200000, z: 1.7 };
  const [boom, ...rest] = booms(air, far);
  assert.equal(rest.length, 0);
  // About a quarter of an hour later, turned near the stratopause, a pascal or so and over half a second long.
  assert.ok(boom.ray.seconds > 700 && boom.ray.seconds < 1000, `${boom.ray.seconds}`);
  assert.ok(boom.topMetres > 40000 && boom.topMetres < 52000, `${boom.topMetres}`);
  const pressure = boom.overpressurePa * boom.focus;
  assert.ok(pressure > .2 && pressure < 5, `${pressure}`);
  assert.ok(boom.durationSeconds > .4 && boom.durationSeconds < 1);
  assert.ok(boom.ray.arrival.z < 0 && boom.absorptionExcess > 0);
  // Inside the ring the rays overshoot; with the upper wind against them, or none, none come back.
  assert.equal(booms(air, { x: 0, y: 60000, z: 1.7 }).length, 0);
  assert.equal(booms({ ...air, upperWindFromDegrees: 90 }, far).length, 0);
  assert.equal(booms({ ...air, upperWindMetresPerSecond: 0 }, far).length, 0);
  assert.equal(booms({ ...air, refraction: false }, far).length, 0);
});

test('a secondary boom reaches the receiver with its ground reflection, from its turning height, and is no shock', () => {
  const scene = defaultScene('sonic');
  scene.emitters = [concorde(scene)];
  scene.receivers = [{ ...scene.receivers[0], positionMetres: { x: 0, y: 200000, z: 1.7 } }];
  const paths = receiverPaths(prepareScene(scene), scene.receivers[0], scene);
  const aloft = Array.from({ length: paths.count }, (_, index) => index).filter(index => paths.aloft[index]);
  assert.equal(aloft.length, 2);
  assert.deepEqual(aloft.map(index => paths.kind[index]).sort(), [0, 1]);
  for (const index of aloft) assert.ok(paths.height[index] > 40000);
});
