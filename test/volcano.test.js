import assert from 'node:assert/strict';
import test from 'node:test';
import { VOLCANO } from '../src/domain/constants.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultScene, defaultVolcano, parseScene, readScene, serializeScene } from '../src/domain/scene.js';
import { applyEruption, codaSamples, eruptionOf, volcanoSources } from '../src/domain/volcano.js';
import { fft, nextPowerOfTwo } from '../src/shared/domain/fft.js';
import { plainScene } from './plain-scene.js';

const SAMPLE_RATE = 48000;

function freeVolcano(volcano, distance) {
  const scene = plainScene('blast');
  scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
  scene.ground = { ...scene.ground, enabled: false };
  scene.emitters = [{ ...defaultVolcano(), ...volcano }];
  scene.receivers[0].positionMetres = { x: distance, y: 0, z: 0 };
  const value = parseScene(scene);
  return renderReceiver(prepareScene(value), value.receivers[0], value);
}

function energyAbove(samples, frequencyHz) {
  const size = nextPowerOfTwo(samples.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(samples);
  fft(re, im);
  let sum = 0;
  for (let bin = Math.ceil(frequencyHz * size / SAMPLE_RATE); bin < size / 2; bin += 1) sum += re[bin] ** 2 + im[bin] ** 2;
  return sum;
}

test('a volcano opens as a Vulcanian explosion on the ground, keeps a raised vent, and its scene round-trips', () => {
  const volcano = defaultVolcano();
  assert.equal(eruptionOf(volcano), 'vulcanian');
  assert.equal(volcano.positionMetres.z, 0);
  const scene = { ...defaultScene('blast'), emitters: [volcano] };
  assert.deepEqual(readScene(JSON.parse(serializeScene(parseScene(scene)))).emitters, [volcano]);
  const raised = { ...volcano, positionMetres: { x: 0, y: 0, z: 1200 } };
  assert.equal(readScene(JSON.parse(serializeScene(parseScene({ ...scene, emitters: [raised] })))).emitters[0].positionMetres.z, 1200);
});

test('a volcano missing a field takes its default, and one out of range is brought into it', () => {
  const { thumpShare, ...rest } = defaultVolcano();
  const read = readScene({ ...defaultScene('blast'), emitters: [{ ...rest, pressureAtKilometrePa: 1e9 }] }).emitters[0];
  assert.equal(read.thumpShare, thumpShare);
  assert.equal(read.pressureAtKilometrePa, 10000);
});

test('an eruption type sets the source and leaves the vent and onset alone; any change makes it custom', () => {
  const volcano = { ...defaultVolcano(), positionMetres: { x: 50, y: 20, z: 0 }, startSeconds: 3 };
  applyEruption(volcano, 'strombolian');
  assert.equal(eruptionOf(volcano), 'strombolian');
  assert.deepEqual([volcano.positionMetres, volcano.startSeconds], [{ x: 50, y: 20, z: 0 }, 3]);
  volcano.thumpShare = .5;
  assert.equal(eruptionOf(volcano), 'custom');
});

test('the pulse is the set pressure at 1 km and falls off as 1/r', () => {
  const [pulse, coda] = volcanoSources(defaultVolcano(), defaultScene('blast').air);
  assert.equal(pulse.amplitudePaMetres, 300 * VOLCANO.referenceMetres);
  assert.equal(coda.pulse, 'noise');
  const quiet = { codaDecibels: -60, riseTimeSeconds: 2e-5 };
  const near = freeVolcano(quiet, 1000).peakPa;
  const far = freeVolcano(quiet, 2000).peakPa;
  assert.ok(Math.abs(near / 300 - 1) < .05, `${near} Pa at 1 km`);
  assert.ok(Math.abs(near / far - 2) < .05, `ratio ${near / far}`);
});

test('a slower rise takes the highs out of the whole explosion', () => {
  const sharp = freeVolcano({ riseTimeSeconds: 4e-5 }, 1000);
  const soft = freeVolcano({ riseTimeSeconds: 2e-3 }, 1000);
  const ratio = energyAbove(soft.samples, 1000) / energyAbove(sharp.samples, 1000);
  assert.ok(ratio < 1e-3, `soft/sharp above 1 kHz ${ratio}`);
});

test('the coda repeats with its seed, and its thumps follow the emitter so both noise parts thump together', () => {
  const volcano = { ...defaultVolcano(), thumpShare: 1 };
  assert.deepEqual(codaSamples(4, 2, SAMPLE_RATE, volcano), codaSamples(4, 2, SAMPLE_RATE, volcano));
  const envelope = samples => {
    const window = SAMPLE_RATE / 50;
    return Array.from({ length: Math.floor(samples.length / window) }, (_, index) => Math.sqrt(samples.slice(index * window, (index + 1) * window).reduce((sum, value) => sum + value * value, 0) / window));
  };
  const correlation = (a, b) => {
    const mean = list => list.reduce((sum, value) => sum + value, 0) / list.length;
    const [ma, mb] = [mean(a), mean(b)];
    let ab = 0; let aa = 0; let bb = 0;
    a.forEach((value, index) => { ab += (value - ma) * (b[index] - mb); aa += (value - ma) ** 2; bb += (b[index] - mb) ** 2; });
    return ab / Math.sqrt(aa * bb);
  };
  const together = correlation(envelope(codaSamples(4, 2, SAMPLE_RATE, volcano)), envelope(codaSamples(5, 2, SAMPLE_RATE, volcano)));
  const apart = correlation(envelope(codaSamples(4, 2, SAMPLE_RATE, volcano)), envelope(codaSamples(4, 2, SAMPLE_RATE, { ...volcano, seed: volcano.seed + 1 })));
  assert.ok(together > .6 && together > apart + .3, `same thumps ${together}, other thumps ${apart}`);
});

test('the coda without thumps keeps the Dukono roar\'s slope against 0.2 kHz: about −7 dB at 0.9 kHz and −20 dB at 2–5 kHz', () => {
  const samples = codaSamples(9, 3, SAMPLE_RATE, { ...defaultVolcano(), thumpShare: 0 });
  const band = (low, high) => energyAbove(samples, low) - energyAbove(samples, high);
  const level = (low, high) => 10 * Math.log10(band(low, high) / band(160, 315));
  assert.ok(level(630, 1250) < -4 && level(630, 1250) > -10, `0.9 kHz ${level(630, 1250)}`);
  assert.ok(level(2500, 5000) < -16 && level(2500, 5000) > -24, `3.5 kHz ${level(2500, 5000)}`);
});
