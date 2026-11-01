import assert from 'node:assert/strict';
import test from 'node:test';
import { GAS_EXPLOSION } from '../src/domain/constants.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultGasExplosion, defaultScene, parseScene, readScene, serializeScene } from '../src/domain/scene.js';
import { cloudRadiusMetres, combustionSamples, gasRegions, multiEnergyOverpressure, multiEnergyPositivePhase, positivePhaseShare, roarSamples, flameMetresPerSecond, gasExplosionPulse, gasExplosionSources, gasRoarTailSeconds, gasSourcePa, gasStrength, strengthOfPa } from '../src/domain/gas-explosion.js';
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

test('the GAME correlation sets the source pressure, within the Multi-Energy range, and a burster charge detonates the cloud', () => {
  const base = { ...defaultGasExplosion(), cloudCubicMetres: 2 * Math.PI / 3 * 1000 };
  const expected = 0.84 * (0.1 * 10 / 0.3) ** 2.75 * 0.45 ** 2.7 * 0.3 ** 0.7 * 1e5;
  assert.ok(Math.abs(gasSourcePa(base) / expected - 1) < 1e-9);
  const planes = 3.38 * (0.1 * 10 / 0.3) ** 2.25 * 0.45 ** 2.7 * 0.3 ** 0.7 * 1e5;
  assert.ok(Math.abs(gasSourcePa({ ...base, confinement: 'planes' }) / planes - 1) < 1e-9);
  assert.equal(gasSourcePa({ ...base, congestion: 'open' }), 1000);
  assert.equal(gasSourcePa({ ...base, fuel: 'hydrogen', congestion: 'pipeRack' }), 1e6);
  assert.equal(gasStrength({ ...base, congestion: 'open', ignition: 'charge' }), 10);
  assert.ok(gasSourcePa({ ...base, fuel: 'methane' }) < gasSourcePa(base) && gasSourcePa(base) < gasSourcePa({ ...base, fuel: 'ethylene' }));
  assert.ok(gasSourcePa({ ...base, cloudCubicMetres: 500 }) < gasSourcePa(base));
});

test('the strength runs through the Multi-Energy classes on a log scale', () => {
  assert.equal(strengthOfPa(1000), 1);
  assert.equal(strengthOfPa(1e6), 10);
  assert.ok(Math.abs(strengthOfPa(1e5) - 7) < 1e-12);
  assert.ok(Math.abs(strengthOfPa(Math.sqrt(1e5 * 2e5)) - 7.5) < 1e-12);
});

test('a 10 m hemisphere near strength 7 gives about 1 kPa and 60 ms near 1 km, as Van den Berg et al. (1991)', () => {
  const cloudCubicMetres = 2 * Math.PI / 3 * 1000;
  assert.ok(Math.abs(cloudRadiusMetres(cloudCubicMetres) - 10) < 1e-9);
  const pulse = gasExplosionPulse({ ...defaultGasExplosion(), cloudCubicMetres }, STANDARD_AIR);
  assert.ok(Math.abs(pulse.strength - 7) < .3, `strength ${pulse.strength}`);
  const groundPa = 2 * pulse.peakPaMetres / 1000;
  assert.ok(groundPa > 800 && groundPa < 1300, `${groundPa} Pa`);
  assert.ok(pulse.durationSeconds > .04 && pulse.durationSeconds < .08, `${pulse.durationSeconds} s`);
  assert.equal(pulse.onsetSeconds, 0);
});

test('the level follows the Multi-Energy curves read from GAME Figure 1, and strong clouds merge far away', () => {
  const at = (kpa, scaledDistance) => multiEnergyOverpressure(kpa * 1000 * (1 + 1e-9), scaledDistance, 101325);
  assert.ok(Math.abs(at(1000, 10) / .0243 - 1) < .01);
  assert.ok(Math.abs(at(20, 20) / .00596 - 1) < .03);
  assert.ok(Math.abs(at(10, 30) / .00214 - 1) < .03);
  assert.ok(Math.abs(at(5, .3) / (5000 / 101325) - 1) < .01);
  const strong = [{ congestion: 'dense' }, { congestion: 'dense', confinement: 'planes' }, { congestion: 'pipeRack' }, { congestion: 'open', ignition: 'charge' }]
    .map(change => gasExplosionPulse({ ...defaultGasExplosion(), ...change }, STANDARD_AIR).peakPaMetres);
  strong.forEach(level => assert.ok(Math.abs(20 * Math.log10(level / strong[0])) < .5));
  const sparse = ['open', 'planes'].map(confinement => gasExplosionPulse({ ...defaultGasExplosion(), congestion: 'sparse', confinement }, STANDARD_AIR).peakPaMetres);
  assert.ok(20 * Math.log10(sparse[1] / sparse[0]) > 3);
});

test('the positive phase follows the Multi-Energy durations read from GAME Figure 2', () => {
  const at = kpa => multiEnergyPositivePhase(kpa * 1000 * (1 + 1e-9));
  assert.ok(Math.abs(at(1) - 4.94) < .01);
  assert.ok(Math.abs(at(20) - .70) < .01);
  assert.ok(Math.abs(at(1000) - .518) < .01);
  assert.ok(Math.abs(at(Math.sqrt(5 * 10)) - Math.sqrt(2.01 * 1.24)) < .01);
  assert.ok(Math.abs(positivePhaseShare(0, 1) - 1) < 1e-12);
  assert.ok(Math.abs(positivePhaseShare(1, 1) - Math.E / (Math.E - 1)) < 1e-9);
});

test('a weak deflagration rises over its Friedlander duration, and the flame speed gives back its source pressure', () => {
  const explosion = { ...defaultGasExplosion(), fuel: 'methane', congestion: 'open', cloudCubicMetres: 1000 };
  const pulse = gasExplosionPulse(explosion, STANDARD_AIR);
  const speed = flameMetresPerSecond(pulse.sourcePa, STANDARD_AIR);
  const density = 101325 / (287.05 * 288.15);
  assert.ok(Math.abs(2 * density * (1 - 1 / GAS_EXPLOSION.expansionRatio) * speed ** 2 - pulse.sourcePa) < 1e-6);
  assert.ok(Math.abs(pulse.onsetSeconds - pulse.durationSeconds) < 1e-12);
  assert.ok(pulse.positiveSeconds > pulse.burnSeconds);
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
  const start = near.samples.findIndex(value => value > 1e-3 * nearPeak.value);
  const end = near.samples.findIndex((value, index) => index > nearPeak.index && value < 0);
  const positiveSeconds = (end - start) / near.sampleRate;
  assert.ok(Math.abs(positiveSeconds / pulse.positiveSeconds - 1) < .05, `positive phase ${positiveSeconds} s, model ${pulse.positiveSeconds} s`);
  assert.ok(near.samples.every(Number.isFinite));
});

test('a rendered dense cloud keeps to the Multi-Energy level far away, aging as a weak shock only beyond the reference distance', () => {
  const explosion = { fuel: 'propane', congestion: 'dense', cloudCubicMetres: 1000 };
  const pulse = gasExplosionPulse({ ...defaultGasExplosion(), ...explosion }, STANDARD_AIR);
  const scaleMetres = pulse.agingRadiusMetres / GAS_EXPLOSION.multiEnergy.referenceScaledDistance;
  for (const scaledDistance of [24, 90]) {
    const heard = peak(freeGasExplosion(explosion, scaledDistance * scaleMetres)).value;
    const expected = multiEnergyOverpressure(pulse.sourcePa, scaledDistance, 101325) * 101325 / 2;
    assert.ok(Math.abs(20 * Math.log10(heard / expected)) < .5, `R̄ ${scaledDistance}: ${20 * Math.log10(heard / expected)} dB`);
  }
});

test('a deflagration roars for its burn time before it dies away, and a detonation at once', () => {
  const rms = (samples, from, to, rate) => {
    let sum = 0;
    for (let index = Math.round(from * rate); index < Math.round(to * rate); index += 1) sum += samples[index] ** 2;
    return Math.sqrt(sum / (Math.round(to * rate) - Math.round(from * rate)));
  };
  const rate = 8000;
  const slow = { ...defaultGasExplosion(), fuel: 'methane', congestion: 'open', cloudCubicMetres: 1000 };
  const burn = gasExplosionPulse(slow, STANDARD_AIR).burnSeconds;
  const [, roar] = gasExplosionSources(slow, STANDARD_AIR);
  assert.ok(Math.abs(roar.durationSeconds - burn - gasRoarTailSeconds(slow)) < 1e-12);
  const samples = combustionSamples(7, roar.durationSeconds, rate, slow);
  assert.ok(rms(samples, 0, .05 * burn, rate) < .3 * rms(samples, .5 * burn, burn, rate));
  assert.ok(rms(samples, burn + 2 * gasRoarTailSeconds(slow) / 3, burn + gasRoarTailSeconds(slow), rate) < .2 * rms(samples, .5 * burn, burn, rate));
  const fast = { ...slow, ignition: 'charge' };
  const [, quick] = gasExplosionSources(fast, STANDARD_AIR);
  const sharp = combustionSamples(7, quick.durationSeconds, rate, fast);
  assert.ok(rms(sharp, 0, .02, rate) > .5 * rms(sharp, .02, .07, rate));
});

test('a bigger cloud roars lower', () => {
  const centroid = cloudCubicMetres => {
    const samples = roarSamples(3, { burnSeconds: .2, tailSeconds: .5, strength: 2, radiusMetres: cloudRadiusMetres(cloudCubicMetres) }, 8000);
    let [low, total] = [0, 0];
    for (let index = 1; index < samples.length; index += 1) { const step = samples[index] - samples[index - 1]; low += samples[index] ** 2; total += step ** 2; }
    return Math.sqrt(total / low);
  };
  assert.ok(centroid(5000) < .6 * centroid(150), `${centroid(5000)} against ${centroid(150)}`);
});

test('dense regions burst one by one as the open cloud\'s slow flame reaches them, none by default or for a detonation', () => {
  const sources = emitter => gasExplosionSources(emitter, STANDARD_AIR);
  assert.equal(sources(defaultGasExplosion()).length, 2);
  assert.equal(gasRegions({ ...defaultGasExplosion(), denseRegions: 3, ignition: 'charge' }, STANDARD_AIR), null);
  const split = gasRegions({ ...defaultGasExplosion(), denseRegions: 3 }, STANDARD_AIR);
  assert.equal(split.regions.length, 3);
  assert.ok(split.open.strength < 2 && split.regions.every(region => region.pulse.strength > split.open.strength + 2));
  assert.ok(split.regions.every(region => region.delaySeconds > 0 && region.delaySeconds < split.open.burnSeconds));
  const radius = cloudRadiusMetres(defaultGasExplosion().cloudCubicMetres);
  assert.ok(split.regions.every(({ offsetMetres: { x, y } }) => Math.hypot(x, y) <= .9 * radius + 1e-9));
  const rendered = sources({ ...defaultGasExplosion(), denseRegions: 3 });
  assert.equal(rendered.length, 5);
  assert.deepEqual(rendered.slice(1, 4).map(source => source.emissionSeconds), split.regions.map(region => region.delaySeconds));
});
