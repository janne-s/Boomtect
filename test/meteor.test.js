import assert from 'node:assert/strict';
import test from 'node:test';
import { BLAST, GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN } from '../src/domain/constants.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from '../src/domain/air.js';
import { meteorBlast, meteorBoom, meteorBursts, meteorKineticEnergy, meteorTrail, showerMembers } from '../src/domain/meteor.js';
import { emitterSources } from '../src/domain/emitters.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultMeteor, defaultShower, parseScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';

test('a meteor’s blast radius is √(E₀/p) = M·d·√(γ·C_D·π/8)', () => {
  const air = plainScene('sonic').air;
  const meteor = defaultMeteor();
  const height = 60000;
  const c = Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, height));
  const mach = meteor.speedKilometresPerSecond * 1000 / c;
  const expected = mach * meteor.diameterMetres * Math.sqrt(GAMMA_AIR * meteor.dragCoefficient * Math.PI / 8);
  const { radiusMetres } = meteorBlast(meteor, air, height);
  assert.ok(Math.abs(radiusMetres / expected - 1) < 1e-9, `${radiusMetres} vs ${expected}`);
});

test('a meteor’s boom follows ReVelle: Δp/p = 0.0309 at 10 R₀, then x^(−3/4), and x^(−1/2) once linear', () => {
  const air = plainScene('sonic').air;
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
  const scene = plainScene('sonic');
  scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
  scene.ground = { ...scene.ground, enabled: false };
  scene.emitters = [{ ...defaultMeteor(), startMetres: { x: -20000, y: 0, z: 60000 }, headingDegrees: 90, entryDegrees: 35, speedKilometresPerSecond: 20, endHeightMetres: 20000, diameterMetres, breakupCount: 0, burstShare: 0 }];
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

test('a meteor breaks up in generations of fragments from its strength, seeded, and bursts where its trail ends', () => {
  const air = plainScene('sonic').air;
  const meteor = { ...defaultMeteor(), breakupCount: 4 };
  const bursts = meteorBursts(meteor, air);
  assert.deepEqual(meteorBursts(meteor, air), bursts);
  assert.notDeepEqual(meteorBursts({ ...meteor, seed: meteor.seed + 1 }, air), bursts);
  // 1 + 2 + 4 + 8 fragments, those whose pressure the trail reaches, and the burst.
  assert.ok(bursts.length > 8 && bursts.length <= 16, `${bursts.length}`);
  const speed = meteor.speedKilometresPerSecond * 1000;
  const ram = z => pressureAtHeightPa(air, z) / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, z)) * speed * speed;
  const energy = meteorKineticEnergy(meteor);
  assert.ok(Math.abs(energy / (3300 * Math.PI / 6 * meteor.diameterMetres ** 3 * speed * speed / 2) - 1) < 1e-12);
  const breakups = bursts.slice(0, -1);
  for (const burst of breakups) {
    // Within the pressure spread of one of the generations: S·2^k·e^(±4σ).
    const ratio = Math.log2(ram(burst.positionMetres.z) / (meteor.strengthMegapascals * 1e6));
    assert.ok(ratio > -3 && ratio < meteor.breakupCount + 2, `${ratio}`);
    // Each fragment of generation k carries the breakup share over 2^k.
    const share = burst.chargeKilograms * 4.184e6 / (meteor.breakupShare * energy);
    assert.ok([1, 2, 4, 8].some(fragments => Math.abs(share * fragments - 1) < 1e-9));
  }
  const last = bursts.at(-1);
  assert.ok(Math.abs(last.positionMetres.z - meteor.endHeightMetres) < 1e-6);
  assert.ok(Math.abs(last.chargeKilograms - .3 * energy / 4.184e6) < 1e-9);
  // Each lies on the trail at the time the body passes, in order along it.
  const { start, direction } = meteorTrail(meteor);
  for (const burst of bursts) {
    const along = (burst.emissionSeconds - meteor.startSeconds) * speed;
    assert.ok(Math.abs(start.x + direction.x * along - burst.positionMetres.x) < 1e-6);
  }
  assert.ok(bursts.every((burst, index) => !index || burst.emissionSeconds >= bursts[index - 1].emissionSeconds));
  // A body too strong for its trail only bursts; no shares, no blasts.
  assert.equal(meteorBursts({ ...meteor, strengthMegapascals: 100 }, air).length, 1);
  assert.equal(meteorBursts({ ...meteor, breakupShare: 0, burstShare: 0 }, air).length, 0);
});

test('a burst high in thin air is a ground blast scaled by Sachs: larger, longer, and louder on its way down', () => {
  const air = plainScene('sonic').air;
  const meteor = defaultMeteor();
  const sources = emitterSources(meteor, air).sources;
  const places = meteorBursts(meteor, air);
  assert.equal(sources.length, 1 + places.length);
  assert.ok(sources[0].flight && sources.slice(1).every(source => source.pulse === 'friedlander'));
  const burst = sources.at(-1);
  const place = places.at(-1);
  const scale = air.pressureKpa * 1000 / pressureAtHeightPa(air, place.positionMetres.z);
  const cubeRoot = Math.cbrt(place.chargeKilograms * scale);
  assert.ok(Math.abs(burst.linearRadiusMetres / (20 * cubeRoot) - 1) < 1e-9);
  const slower = Math.sqrt(temperatureAtHeightKelvin(air, 0) / temperatureAtHeightKelvin(air, place.positionMetres.z));
  assert.ok(Math.abs(burst.durationSeconds / (.006 * cubeRoot * slower) - 1) < 1e-9);
  // A large meteoroid's burst is held to the longest positive phase, and its scene renders.
  const large = { ...meteor, diameterMetres: 50 };
  assert.ok(emitterSources(large, air).sources.slice(1).every(source => source.durationSeconds === BLAST.maximumHighBlastSeconds));
  const scene = plainScene('sonic');
  scene.emitters = [large];
  const parsed = parseScene(scene);
  assert.ok(renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed).samples.every(Number.isFinite));
});

test('a meteor’s breakups and burst are heard after its boom when they lie past its stationary point', () => {
  const scene = plainScene('sonic');
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

test('a meteor’s cone is drawn with the speed of sound at its height, not the linear fit extended far above it', async () => {
  const { machCone } = await import('../src/domain/flight.js');
  const { meteorTrack } = await import('../src/domain/meteor.js');
  const { soundSpeedProfile } = await import('../src/domain/refraction.js');
  const parsed = parseScene(plainScene('sonic'));
  const meteor = { ...defaultMeteor(), endHeightMetres: 60000 };
  const track = meteorTrack(meteor);
  const now = track.seconds.at(-1) + 30;
  const cone = machCone(track, now, soundSpeedProfile(parsed.air));
  assert.ok(cone && cone.rings.length > 5);
  // The oldest ring: from the start of the trail, 30 s and more ago; its radius is about c(z)·t.
  const ring = cone.rings.at(-1);
  const centre = ring.reduce((sum, point) => ({ x: sum.x + point.x / ring.length, y: sum.y + point.y / ring.length, z: sum.z + point.z / ring.length }), { x: 0, y: 0, z: 0 });
  const radius = Math.hypot(ring[0].x - centre.x, ring[0].y - centre.y, ring[0].z - centre.z);
  const c = Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(parsed.air, track.z[0]));
  assert.ok(Math.abs(radius / (c * (now - track.seconds[0])) - 1) < .1, `${radius} vs ${c * (now - track.seconds[0])}`);
});
