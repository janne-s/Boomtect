import assert from 'node:assert/strict';
import test from 'node:test';
import { carlsonBoom, flightBooms, machCone } from '../src/domain/flight.js';
import { flightPath, withApproach } from '../src/shared/domain/trajectory.js';
import { soundSpeedProfile } from '../src/shared/domain/refraction.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultFlight, parseScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';

const stillAir = { ...plainScene('sonic').air, refraction: false };
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
  const air = plainScene('sonic').air;
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
  const scene = plainScene('sonic');
  scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
  scene.ground = { ...scene.ground, enabled: false };
  scene.emitters = [{ ...level(), riseTimeSeconds: 1e-3 }];
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
  const formation = { ...defaultFormation(), startMetres: { x: -30000, y: 0, z: 10000 }, mach: 2, durationSeconds: 120, headingDegrees: 90, memberCount: 3, lateralSpacingMetres: 1000, trailSpacingMetres: 1500 };
  const members = flightMembers(formation);
  assert.deepEqual(members.map(member => [Math.round(member.startMetres.x), Math.round(member.startMetres.y)]), [[-30000, 0], [-31500, -1000], [-31500, 1000]]);
  const scene = plainScene('sonic');
  scene.emitters = [formation];
  const parsed = parseScene(scene);
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  assert.equal([...result.arrivals.kinds].filter(kind => kind === 0).length, 3);
  assert.ok(result.samples.every(Number.isFinite));
});

test('the Mach cone drawn at the clock opens at asin(1/M) behind the body, and a subsonic flight has none', () => {
  const flight = level();
  const path = flightPath(flight, stillAir);
  const profile = soundSpeedProfile(stillAir);
  const cone = machCone(path, 60, profile);
  assert.ok(cone.apex && cone.rings.length > 10);
  const halfAngle = Math.asin(1 / flight.mach);
  for (const ring of cone.rings) {
    for (const point of ring) {
      const back = { x: cone.apex.x - point.x, y: point.y - cone.apex.y, z: point.z - cone.apex.z };
      const angle = Math.atan2(Math.hypot(back.y, back.z), back.x);
      assert.ok(Math.abs(angle - halfAngle) < 1e-3, `${angle} vs ${halfAngle}`);
    }
  }
  assert.equal(machCone(flightPath(level({ mach: .8 }), stillAir), 60, profile), null);
  assert.equal(machCone(path, -1, profile), null);
});

test('turbulence spikes a boom’s front, seeded, while its N-wave keeps its area', () => {
  const render = turbulenceStrength => {
    const scene = plainScene('sonic');
    scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength };
    scene.ground = { ...scene.ground, enabled: false };
    scene.emitters = [level()];
    const parsed = parseScene(scene);
    return renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  };
  const calm = render(0);
  const rough = render(1e-6);
  assert.deepEqual(rough.samples, render(1e-6).samples);
  const area = samples => samples.reduce((sum, value) => sum + Math.max(0, value), 0);
  assert.ok(Math.abs(area(rough.samples) / area(calm.samples) - 1) < .05);
  const peak = samples => samples.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  assert.ok(Math.abs(peak(rough.samples) / peak(calm.samples) - 1) > .03, `${peak(rough.samples)} vs ${peak(calm.samples)}`);
});

test('a body supersonic at its start has flown before it: a microphone beside the start hears its boom', () => {
  const scene = plainScene('sonic');
  scene.emitters = [{ ...defaultFlight(), startMetres: { x: -500, y: 0, z: 6000 } }];
  const parsed = parseScene(scene);
  const flight = parsed.emitters[0];
  const path = flightPath(flight, parsed.air);
  const receiver = parsed.receivers[0].positionMetres;
  assert.equal(flightBooms(path, flight, receiver, soundSpeedProfile(parsed.air), parsed.air).length, 0);
  const [boom] = flightBooms(withApproach(path, parsed.air), flight, receiver, soundSpeedProfile(parsed.air), parsed.air);
  assert.ok(boom && boom.emissionSeconds < flight.startSeconds && boom.point.x < flight.startMetres.x);
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  assert.ok(result.peakPa > 10, `${result.peakPa} Pa`);
});

test('the default flight is heard within about half a minute, all of it within a few kilometres of the origin', () => {
  const parsed = parseScene(plainScene('sonic'));
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  const first = result.arrivals.seconds.reduce((earliest, seconds) => Math.min(earliest, seconds), Infinity);
  assert.ok(first > 15 && first < 40, `${first} s`);
  const path = flightPath(parsed.emitters[0], parsed.air);
  assert.ok(Math.max(...path.x.map(Math.abs)) < 10000);
});

test('beyond the edge of its carpet a boom creeps into the shadow, weaker and darker', () => {
  const at = offMetres => {
    const scene = plainScene('sonic');
    scene.emitters = [{ ...defaultFlight(), startMetres: { x: -150000, y: 0, z: 18000 }, mach: 2, durationSeconds: 300 }];
    scene.receivers[0].positionMetres = { x: 0, y: offMetres, z: 1.7 };
    const parsed = parseScene(scene);
    const flight = parsed.emitters[0];
    const booms = flightBooms(withApproach(flightPath(flight, parsed.air), parsed.air), flight, parsed.receivers[0].positionMetres, soundSpeedProfile(parsed.air), parsed.air);
    const { samples } = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
    let total = 0;
    let smooth = 0;
    for (let index = 4; index < samples.length; index += 1) {
      const mean = (samples[index] + samples[index - 1] + samples[index - 2] + samples[index - 3] + samples[index - 4]) / 5;
      total += samples[index] ** 2;
      smooth += mean ** 2;
    }
    return { booms, peak: samples.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0), bright: 1 - smooth / total };
  };
  const inside = at(40000);
  const beyond = at(50000);
  assert.ok(inside.booms.length && inside.booms.every(boom => !boom.shadow));
  assert.ok(beyond.booms.length && beyond.booms.every(boom => boom.shadow && boom.ray.creepMetres > 0));
  assert.ok(beyond.peak < inside.peak / 2, `${beyond.peak} against ${inside.peak}`);
  assert.ok(beyond.bright < inside.bright / 2, `${beyond.bright} against ${inside.bright}`);
});
