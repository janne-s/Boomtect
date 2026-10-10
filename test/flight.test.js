import assert from 'node:assert/strict';
import test from 'node:test';
import { carlsonBoom, flightBooms, flightPath } from '../src/domain/flight.js';
import { soundSpeedProfile } from '../src/domain/refraction.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultFlight, defaultScene, parseScene } from '../src/domain/scene.js';

const stillAir = { ...defaultScene('sonic').air, refraction: false };
const level = (change = {}) => ({ ...defaultFlight(), startMetres: { x: -30000, y: 0, z: 10000 }, mach: 2, durationSeconds: 120, ...change });
const origin = { x: 0, y: 0, z: 0 };

test('Carlson’s simplified method reproduces his sample problems', () => {
  // Problem 1, reconnaissance aircraft: 74 Pa and 0.17 s; problem 3, Apollo in ascent: 184 Pa and 3.90 s.
  const first = carlsonBoom({ mach: 1.99, vehiclePressurePa: 11600, groundPressurePa: 92300, vehicleSoundSpeed: 295, lengthMetres: 32.7, shapeFactor: .087, distanceMetres: 14480, pressureFactor: 1.1, durationFactor: .85, reflectionFactor: 2 });
  assert.ok(Math.abs(first.overpressurePa - 74) < 1, `${first.overpressurePa}`);
  assert.ok(Math.abs(first.durationSeconds - .17) < .005, `${first.durationSeconds}`);
  const apollo = carlsonBoom({ mach: 4.08, vehiclePressurePa: 490, groundPressurePa: 101000, vehicleSoundSpeed: 310, lengthMetres: 104.5, shapeFactor: .68, distanceMetres: 50200, pressureFactor: 1.4, durationFactor: .73, reflectionFactor: 2 });
  assert.ok(Math.abs(apollo.overpressurePa - 184) < 2, `${apollo.overpressurePa}`);
  assert.ok(Math.abs(apollo.durationSeconds - 3.9) < .03, `${apollo.durationSeconds}`);
});

test('in still air a steady boom arrives h·√(M² − 1)/v after the body passes overhead, from the Mach cone', () => {
  const flight = level();
  const path = flightPath(flight, stillAir);
  const [boom, ...rest] = flightBooms(path, flight, origin, soundSpeedProfile(stillAir), stillAir);
  assert.equal(rest.length, 0);
  const speed = path.speed[0];
  const expected = 30000 / speed + 10000 * Math.sqrt(3) / speed;
  assert.ok(Math.abs(boom.emissionSeconds + boom.ray.seconds - expected) < 1e-3, `${boom.emissionSeconds + boom.ray.seconds} vs ${expected}`);
  // The ray leaves at 90° − μ from the path: h·tan μ behind the receiver.
  assert.ok(Math.abs(boom.point.x + 10000 / Math.sqrt(3)) < 5, `${boom.point.x}`);
  assert.ok(Math.abs(boom.focus - 1) < 1e-3);
});

test('a subsonic body leaves no boom, nor one the air turns away before the ground (Mach cutoff near 1.153 at 12 km)', () => {
  const air = defaultScene('sonic').air;
  const profile = soundSpeedProfile(air);
  const booms = mach => {
    const flight = level({ startMetres: { x: -60000, y: 0, z: 12000 }, mach, durationSeconds: 300 });
    return flightBooms(flightPath(flight, air), flight, { x: 0, y: 0, z: 1.7 }, profile, air).length;
  };
  assert.equal(booms(.9), 0);
  assert.equal(booms(1.13), 0);
  assert.equal(booms(1.2), 1);
});

test('turning or accelerating flight focuses its boom where its rays converge', () => {
  const flight = level({ turnDegreesPerSecond: -3, durationSeconds: 120 });
  const path = flightPath(flight, stillAir);
  const profile = soundSpeedProfile(stillAir);
  let strongest = 0;
  for (let x = -20000; x <= 20000; x += 2000) {
    for (let y = -20000; y <= 20000; y += 2000) {
      for (const boom of flightBooms(path, flight, { x, y, z: 0 }, profile, stillAir)) strongest = Math.max(strongest, boom.focus);
    }
  }
  assert.ok(strongest > 1.3, `${strongest}`);
});

test('the rendered N-wave carries Carlson’s overpressure and duration in free air', () => {
  const scene = defaultScene('sonic');
  scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
  scene.ground = { ...scene.ground, enabled: false };
  scene.emitters = [{ ...level(), riseTimeSeconds: 1e-4 }];
  const parsed = parseScene(scene);
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  const flight = parsed.emitters[0];
  const [boom] = flightBooms(flightPath(flight, parsed.air), flight, parsed.receivers[0].positionMetres, soundSpeedProfile(parsed.air), parsed.air);
  let peak = 0;
  let peakIndex = 0;
  let trough = 0;
  let troughIndex = 0;
  result.samples.forEach((value, index) => {
    if (value > peak) { peak = value; peakIndex = index; }
    if (value < trough) { trough = value; troughIndex = index; }
  });
  assert.ok(Math.abs(peak / boom.overpressurePa - 1) < .05, `${peak} vs ${boom.overpressurePa}`);
  assert.ok(Math.abs(-trough / boom.overpressurePa - 1) < .05);
  assert.ok(Math.abs((troughIndex - peakIndex) / result.sampleRate / boom.durationSeconds - 1) < .03);
});

test('a formation flies in a vee behind its leader, and each of its aircraft leaves its own boom', async () => {
  const { flightMembers } = await import('../src/domain/flight.js');
  const { defaultFormation } = await import('../src/domain/scene.js');
  const formation = { ...defaultFormation(), startMetres: { x: -30000, y: 0, z: 10000 }, headingDegrees: 90, memberCount: 3, lateralSpacingMetres: 1000, trailSpacingMetres: 1500 };
  const members = flightMembers(formation);
  assert.deepEqual(members.map(member => [Math.round(member.startMetres.x), Math.round(member.startMetres.y)]), [[-30000, 0], [-31500, -1000], [-31500, 1000]]);
  const scene = defaultScene('sonic');
  scene.emitters = [formation];
  const parsed = parseScene(scene);
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  assert.equal([...result.arrivals.kinds].filter(kind => kind === 0).length, 3);
  assert.ok(result.samples.every(Number.isFinite));
});
