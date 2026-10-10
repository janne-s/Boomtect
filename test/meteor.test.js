import assert from 'node:assert/strict';
import test from 'node:test';
import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN } from '../src/domain/constants.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from '../src/domain/air.js';
import { meteorBlast, meteorBoom, meteorTrail, showerMembers } from '../src/domain/meteor.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultMeteor, defaultScene, defaultShower, parseScene } from '../src/domain/scene.js';

test('a meteor’s blast radius is √(E₀/p) = M·d·√(γ·C_D·π/8)', () => {
  const air = defaultScene('sonic').air;
  const meteor = defaultMeteor();
  const height = 60000;
  const c = Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, height));
  const mach = meteor.speedKilometresPerSecond * 1000 / c;
  const expected = mach * meteor.diameterMetres * Math.sqrt(GAMMA_AIR * meteor.dragCoefficient * Math.PI / 8);
  const { radiusMetres } = meteorBlast(meteor, air, height);
  assert.ok(Math.abs(radiusMetres / expected - 1) < 1e-9, `${radiusMetres} vs ${expected}`);
});

test('a meteor’s boom follows ReVelle: Δp/p = 0.0309 at 10 R₀, then x^(−3/4), and x^(−1/2) once linear', () => {
  const air = defaultScene('sonic').air;
  const meteor = defaultMeteor();
  const height = 60000;
  const { radiusMetres } = meteorBlast(meteor, air, height);
  const p = pressureAtHeightPa(air, height);
  // At the trail's own pressure: 2γ/(γ+1)·0.4503/((1 + 4.803·10^(8/3))^(3/8) − 1).
  assert.ok(Math.abs(meteorBoom(meteor, air, height, 10 * radiusMetres, p).overpressurePa / p - .030875) < 1e-5);
  const at = radii => meteorBoom(meteor, air, height, radii * radiusMetres, p).overpressurePa;
  assert.ok(Math.abs(Math.log(at(1000) / at(100)) / Math.log(10) + .75) < 1e-9);
  assert.ok(Math.abs(Math.log(at(1e6) / at(1e5)) / Math.log(10) + .5) < 1e-9);
  // Its N-wave lengthens as x^¼.
  const duration = radii => meteorBoom(meteor, air, height, radii * radiusMetres, p).durationSeconds;
  assert.ok(Math.abs(Math.log(duration(1000) / duration(100)) / Math.log(10) - .25) < 1e-6);
});

/** A meteor's render in plain air without ground, and its stationary arrival over the trail. */
function plainMeteor(diameterMetres) {
  const scene = defaultScene('sonic');
  scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
  scene.ground = { ...scene.ground, enabled: false };
  scene.emitters = [{ ...defaultMeteor(), startMetres: { x: -20000, y: 0, z: 60000 }, endHeightMetres: 20000, diameterMetres }];
  const parsed = parseScene(scene);
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  const { start, direction, speed, lengthMetres } = meteorTrail(parsed.emitters[0]);
  const c = Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * (parsed.air.temperatureCelsius + 273.15));
  const receiver = parsed.receivers[0].positionMetres;
  let earliest = Infinity;
  for (let along = 0; along <= lengthMetres; along += 1) {
    const point = { x: start.x + direction.x * along, y: start.y + direction.y * along, z: start.z + direction.z * along };
    earliest = Math.min(earliest, along / speed + Math.hypot(point.x - receiver.x, point.y - receiver.y, point.z - receiver.z) / c);
  }
  return { result, earliest };
}

test('a meteor’s boom is one N-wave from where its Mach cone reaches the microphone, with a sharp front', () => {
  for (const diameter of [.5, 50]) {
    const { result, earliest } = plainMeteor(diameter);
    const { samples, sampleRate } = result;
    assert.ok(samples.every(Number.isFinite));
    let peak = 0;
    samples.forEach((value, index) => { if (Math.abs(value) > Math.abs(samples[peak])) peak = index; });
    const onset = samples.findIndex(value => Math.abs(value) > .01 * Math.abs(samples[peak]));
    const onsetSeconds = result.startSeconds + onset / sampleRate;
    assert.ok(Math.abs(onsetSeconds - earliest) < .01, `${diameter} m: ${onsetSeconds} vs ${earliest}`);
    // The front rises to half the peak within a few milliseconds, not over the trail's spread of arrivals.
    const half = samples.findIndex(value => Math.abs(value) > .5 * Math.abs(samples[peak]));
    assert.ok((half - onset) / sampleRate < .01, `${diameter} m rises over ${(half - onset) / sampleRate} s`);
  }
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
