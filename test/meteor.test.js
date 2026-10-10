import assert from 'node:assert/strict';
import test from 'node:test';
import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN } from '../src/domain/constants.js';
import { temperatureAtHeightKelvin } from '../src/domain/air.js';
import { meteorSources, meteorTrail, showerMembers } from '../src/domain/meteor.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultMeteor, defaultScene, defaultShower, parseScene } from '../src/domain/scene.js';

test('a meteor’s blast radius is √(E₀/p) = M·d·√(γ·C_D·π/8)', () => {
  const air = defaultScene('sonic').air;
  const meteor = defaultMeteor();
  const [first] = meteorSources(meteor, air);
  const c = Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, first.positionMetres.z));
  const mach = meteor.speedKilometresPerSecond * 1000 / c;
  const expected = mach * meteor.diameterMetres * Math.sqrt(GAMMA_AIR * meteor.dragCoefficient * Math.PI / 8);
  assert.ok(Math.abs(first.weakShock.relaxationRadius / expected - 1) < 1e-9, `${first.weakShock.relaxationRadius} vs ${expected}`);
});

test('a meteor’s boom peaks when its Mach cone reaches the microphone, from the sum of its trail', () => {
  const scene = defaultScene('sonic');
  scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
  scene.ground = { ...scene.ground, enabled: false };
  scene.emitters = [{ ...defaultMeteor(), startMetres: { x: -20000, y: 0, z: 60000 }, endHeightMetres: 20000, diameterMetres: 1 }];
  const parsed = parseScene(scene);
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  let peak = 0;
  result.samples.forEach((value, index) => { if (Math.abs(value) > Math.abs(result.samples[peak])) peak = index; });
  // The stationary arrival over the trail in homogeneous air.
  const { start, direction, speed, lengthMetres } = meteorTrail(parsed.emitters[0]);
  const c = Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * (parsed.air.temperatureCelsius + 273.15));
  const receiver = parsed.receivers[0].positionMetres;
  let earliest = Infinity;
  for (let along = 0; along <= lengthMetres; along += 10) {
    const point = { x: start.x + direction.x * along, y: start.y + direction.y * along, z: start.z + direction.z * along };
    earliest = Math.min(earliest, along / speed + Math.hypot(point.x - receiver.x, point.y - receiver.y, point.z - receiver.z) / c);
  }
  const peakSeconds = result.startSeconds + peak / result.sampleRate;
  assert.ok(Math.abs(peakSeconds - earliest) < .3, `${peakSeconds} vs ${earliest}`);
  assert.ok(result.samples.every(Number.isFinite));
});

test('a shower’s meteors come from one radiant, seeded, at their count and over their disc', () => {
  const shower = defaultShower();
  const members = showerMembers(shower);
  assert.equal(members.length, shower.meteorCount);
  assert.deepEqual(showerMembers(shower), members);
  for (const meteor of members) {
    assert.equal(meteor.headingDegrees, shower.headingDegrees);
    assert.equal(meteor.entryDegrees, shower.entryDegrees);
    assert.ok(Math.hypot(meteor.startMetres.x - shower.startMetres.x, meteor.startMetres.y - shower.startMetres.y) <= shower.radiusMetres);
    assert.ok(meteor.startSeconds >= shower.startSeconds && meteor.startSeconds <= shower.startSeconds + shower.durationSeconds);
  }
});
