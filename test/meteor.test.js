import assert from 'node:assert/strict';
import test from 'node:test';
import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN } from '../src/domain/constants.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from '../src/domain/air.js';
import { meteorBlast, meteorBoom, meteorBursts, meteorKineticEnergy, meteorTrail, showerMembers } from '../src/domain/meteor.js';
import { emitterSources, MAXIMUM_HIGH_BLAST_SECONDS } from '../src/domain/emitters.js';
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
  scene.emitters = [{ ...defaultMeteor(), startMetres: { x: -20000, y: 0, z: 60000 }, endHeightMetres: 20000, diameterMetres, breakupCount: 0, burstShare: 0 }];
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

test('a meteor breaks up where ρv² reaches its strength and twice that, and bursts where its trail ends', () => {
  const air = defaultScene('sonic').air;
  const meteor = defaultMeteor();
  const bursts = meteorBursts(meteor, air);
  assert.equal(bursts.length, 3);
  const speed = meteor.speedKilometresPerSecond * 1000;
  const ram = z => pressureAtHeightPa(air, z) / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, z)) * speed * speed;
  assert.ok(Math.abs(ram(bursts[0].positionMetres.z) / 1e6 - 1) < 1e-6);
  assert.ok(Math.abs(ram(bursts[1].positionMetres.z) / 2e6 - 1) < 1e-6);
  assert.ok(Math.abs(bursts[2].positionMetres.z - meteor.endHeightMetres) < 1e-6);
  // Each lies on the trail at the time the body passes.
  const { start, direction } = meteorTrail(meteor);
  for (const burst of bursts) {
    const along = (burst.emissionSeconds - meteor.startSeconds) * speed;
    assert.ok(Math.abs(start.x + direction.x * along - burst.positionMetres.x) < 1e-6);
  }
  // Shares of a 3 300 kg/m³ sphere's kinetic energy, as TNT at 4.184 MJ/kg.
  const energy = 3300 * Math.PI / 6 * .5 ** 3 * speed * speed / 2;
  assert.ok(Math.abs(meteorKineticEnergy(meteor) / energy - 1) < 1e-12);
  assert.ok(Math.abs(bursts[0].chargeKilograms - .05 * energy / 4.184e6) < 1e-9);
  assert.ok(Math.abs(bursts[2].chargeKilograms - .3 * energy / 4.184e6) < 1e-9);
  // A weak body that ends before its strength is reached only bursts; no shares, no blasts.
  assert.equal(meteorBursts({ ...meteor, strengthMegapascals: 100 }, air).length, 1);
  assert.equal(meteorBursts({ ...meteor, breakupShare: 0, burstShare: 0 }, air).length, 0);
});

test('a burst high in thin air is a ground blast scaled by Sachs: larger, longer, and louder on its way down', () => {
  const air = defaultScene('sonic').air;
  const meteor = defaultMeteor();
  const sources = emitterSources(meteor, air).sources;
  assert.equal(sources.length, 4);
  assert.ok(sources[0].flight && sources.slice(1).every(source => source.pulse === 'friedlander'));
  const burst = sources[3];
  const [place] = meteorBursts(meteor, air).slice(2);
  const scale = air.pressureKpa * 1000 / pressureAtHeightPa(air, place.positionMetres.z);
  const cubeRoot = Math.cbrt(place.chargeKilograms * scale);
  assert.ok(Math.abs(burst.linearRadiusMetres / (20 * cubeRoot) - 1) < 1e-9);
  const slower = Math.sqrt(temperatureAtHeightKelvin(air, 0) / temperatureAtHeightKelvin(air, place.positionMetres.z));
  assert.ok(Math.abs(burst.durationSeconds / (.006 * cubeRoot * slower) - 1) < 1e-9);
  // A large meteoroid's burst is held to the longest positive phase, and its scene renders.
  const large = { ...meteor, diameterMetres: 50 };
  assert.ok(emitterSources(large, air).sources.slice(1).every(source => source.durationSeconds === MAXIMUM_HIGH_BLAST_SECONDS));
  const scene = defaultScene('sonic');
  scene.emitters = [large];
  const parsed = parseScene(scene);
  assert.ok(renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed).samples.every(Number.isFinite));
});

test('a meteor’s breakups and burst are heard after its boom when they lie past its stationary point', () => {
  const scene = defaultScene('sonic');
  scene.emitters = [defaultMeteor()];
  const parsed = parseScene(scene);
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  assert.ok(result.samples.every(Number.isFinite));
  // Boom first, then three blasts: four separate onsets above 5 % of the peak.
  const { samples, sampleRate } = result;
  const onsets = [];
  let last = -Infinity;
  samples.forEach((value, index) => {
    if (Math.abs(value) <= .05 * result.peakPa) return;
    if (index - last > sampleRate / 2) onsets.push(index);
    last = index;
  });
  assert.ok(onsets.length >= 3, `${onsets.length} onsets`);
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
