import assert from 'node:assert/strict';
import test from 'node:test';
import { GAS_EXPLOSION } from '../src/domain/constants.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultGasExplosion, defaultScene, parseScene, readScene, serializeScene } from '../src/domain/scene.js';
import { cloudRadiusMetres, flameMetresPerSecond, gasExplosionPulse, gasExplosionSources, gasStrength } from '../src/domain/gas-explosion.js';
import { blastPressureAtKilometrePa } from '../src/domain/blast-pulse.js';
import { plainScene } from './plain-scene.js';

const STANDARD_AIR = { pressureKpa: 101.325, temperatureCelsius: 15 };

function freeGasExplosion(explosion, distance) {
  const scene = plainScene('blast');
  scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
  scene.ground = { ...scene.ground, enabled: false };
  scene.emitters = [{ ...defaultGasExplosion(), fireballDecibels: -60, ...explosion }];
  scene.receivers[0].positionMetres = { x: distance, y: 0, z: 0 };
  const value = parseScene(scene);
  return renderReceiver(prepareScene(value), value.receivers[0], value);
}

function peak(result) {
  let best = { value: 0, index: 0 };
  result.samples.forEach((value, index) => { if (value > best.value) best = { value, index }; });
  return best;
}

test('a gas explosion opens in Blast mode, reads unknown choices as defaults, and its scene round-trips', () => {
  const explosion = defaultGasExplosion();
  const scene = { ...defaultScene('blast'), emitters: [explosion] };
  assert.deepEqual(readScene(JSON.parse(serializeScene(parseScene(scene)))).emitters, [explosion]);
  const odd = readScene({ ...JSON.parse(serializeScene(parseScene(scene))), emitters: [{ kind: 'gasExplosion', id: 'g', fuel: 'butter', cloudCubicMetres: 1e9 }] }).emitters[0];
  assert.equal(odd.fuel, explosion.fuel);
  assert.equal(odd.cloudCubicMetres, 1e6);
});

test('congestion, confinement and reactivity set the strength, and a burster charge detonates the cloud', () => {
  const base = defaultGasExplosion();
  assert.equal(gasStrength({ ...base, fuel: 'methane', congestion: 'open' }), 1);
  assert.equal(gasStrength({ ...base, fuel: 'propane', congestion: 'pipeRack', confinement: 'planes' }), 8);
  assert.equal(gasStrength({ ...base, fuel: 'hydrogen', congestion: 'open', ignition: 'charge' }), 10);
});

test('strength 7 of a 10 m hemisphere gives about 1 kPa and 60 ms near 1 km, as Van den Berg et al. (1991)', () => {
  const cloudCubicMetres = 2 * Math.PI / 3 * 1000;
  assert.ok(Math.abs(cloudRadiusMetres(cloudCubicMetres) - 10) < 1e-9);
  const pulse = gasExplosionPulse({ ...defaultGasExplosion(), cloudCubicMetres, congestion: 'pipeRack' }, STANDARD_AIR);
  assert.equal(pulse.strength, 7);
  const groundPa = 2 * pulse.peakPaMetres / 1000;
  assert.ok(groundPa > 800 && groundPa < 1300, `${groundPa} Pa`);
  assert.ok(pulse.durationSeconds > .04 && pulse.durationSeconds < .08, `${pulse.durationSeconds} s`);
  assert.equal(pulse.onsetSeconds, 0);
});

test('a detonated cloud is no louder than TNT of the same combustion energy', () => {
  const explosion = { ...defaultGasExplosion(), fuel: 'propyleneOxide', ignition: 'charge', cloudCubicMetres: 500 };
  const pulse = gasExplosionPulse(explosion, STANDARD_AIR);
  const kilograms = GAS_EXPLOSION.fuels.propyleneOxide.megajoulesPerCubicMetre * 500 / GAS_EXPLOSION.tntMegajoulesPerKilogram;
  assert.ok(Math.abs(pulse.kilograms - kilograms) < 1e-9);
  assert.ok(Math.abs(pulse.peakPaMetres - blastPressureAtKilometrePa(kilograms) * 1000) < 1e-6);
});

test('a weak deflagration rises over its burn time, and the flame speed gives back its source pressure', () => {
  const explosion = { ...defaultGasExplosion(), fuel: 'methane', congestion: 'open', cloudCubicMetres: 1000 };
  const pulse = gasExplosionPulse(explosion, STANDARD_AIR);
  const speed = flameMetresPerSecond(pulse.sourcePa, STANDARD_AIR);
  const density = 101325 / (287.05 * 288.15);
  assert.ok(Math.abs(2 * density * (1 - 1 / GAS_EXPLOSION.expansionRatio) * speed ** 2 - pulse.sourcePa) < 1e-6);
  assert.ok(Math.abs(pulse.onsetSeconds - cloudRadiusMetres(1000) / speed) < 1e-12);
  const [shock] = gasExplosionSources(explosion, STANDARD_AIR);
  assert.equal(shock.onsetSeconds, pulse.onsetSeconds);
  assert.ok(shock.amplitudePaMetres > pulse.peakPaMetres);
});

test('a rendered gas explosion peaks at its level after its onset and falls off as 1/r', () => {
  const explosion = { fuel: 'propane', congestion: 'sparse', cloudCubicMetres: 1000 };
  const pulse = gasExplosionPulse({ ...defaultGasExplosion(), ...explosion }, STANDARD_AIR);
  const [near, far] = [200, 400].map(distance => freeGasExplosion(explosion, distance));
  const [nearPeak, farPeak] = [near, far].map(peak);
  assert.ok(Math.abs(nearPeak.value * 200 / pulse.peakPaMetres - 1) < .05, `near ${nearPeak.value * 200 / pulse.peakPaMetres}`);
  assert.ok(Math.abs(nearPeak.value / farPeak.value - 2) < .05, `ratio ${nearPeak.value / farPeak.value}`);
  const arrival = 200 / 340.3;
  const peakSeconds = near.startSeconds + nearPeak.index / near.sampleRate - arrival;
  assert.ok(Math.abs(peakSeconds - pulse.onsetSeconds) < .01, `peak ${peakSeconds} s after arrival, onset ${pulse.onsetSeconds} s`);
  assert.ok(near.samples.every(Number.isFinite));
});
