import assert from 'node:assert/strict';
import test from 'node:test';
import { BLEVE } from '../src/domain/constants.js';
import { emitterSources } from '../src/domain/emitters.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultBleve, parseScene, readScene, serializeScene } from '../src/domain/scene.js';
import { applyVessel, bleveChargeKilograms, bleveContents, fireballOf, fireballRoarSamples, fireballRoarSources, fireballSwell, fireballThumpSamples, saturation, thumpPaMetres, thumpSeed, vesselOf } from '../src/domain/bleve.js';
import { fft, nextPowerOfTwo } from '../src/shared/domain/fft.js';
import { plainScene } from './plain-scene.js';

const STANDARD_AIR = { pressureKpa: 101.325, temperatureCelsius: 15 };

const bam = { ...defaultBleve(), fluid: 'propane', vesselCubicMetres: 45.36, fillShare: .18, failureBar: 24.5, fireballDecibels: -60 };

function heardPeakPa(emitter, distance) {
  const scene = plainScene('blast');
  scene.emitters = [emitter];
  scene.receivers[0].positionMetres = { x: distance, y: 0, z: 1.7 };
  const value = parseScene(scene);
  return renderReceiver(prepareScene(value), value.receivers[0], value).samples.reduce((largest, sample) => Math.max(largest, sample), 0);
}

test('a BLEVE opens in Blast mode, takes a vessel, reads unknown choices as defaults, and its scene round-trips', () => {
  const scene = plainScene('blast');
  scene.emitters = [{ ...defaultBleve(), fluid: 'lava' }];
  const value = readScene(JSON.parse(JSON.stringify(scene)));
  assert.equal(value.emitters[0].fluid, 'propane');
  assert.deepEqual(readScene(JSON.parse(serializeScene(value))), value);
  assert.equal(vesselOf(value.emitters[0]), 'roadTanker');
  const item = { ...defaultBleve() };
  applyVessel(item, 'cylinder11');
  assert.equal(vesselOf(item), 'cylinder11');
  item.fillShare = .5;
  assert.equal(vesselOf(item), 'custom');
});

test('the saturated state runs through the table on a log pressure scale and holds at its ends', () => {
  const at20 = saturation('propane', 20);
  assert.equal(at20.vapourKilojoulesPerKilogram, 124.8);
  assert.equal(saturation('propane', 1.01325).vapourKilojoulesPerKilogram, 0);
  assert.equal(saturation('propane', 100).bar, 40);
  assert.equal(saturation('carbonDioxide', 5).bar, 14.8);
  const between = saturation('water', Math.sqrt(10 * 15));
  assert.ok(between.celsius > 179.9 && between.celsius < 198.3);
});

test('the vapour and liquid energies match Birk et al. (2007) for their 2000 l test and the BAM rail car', () => {
  const tank = bleveContents({ fluid: 'propane', vesselCubicMetres: 2, fillShare: .65, failureBar: 20.2 }, STANDARD_AIR);
  assert.ok(Math.abs(tank.celsius - 60) < 1, `${tank.celsius} °C`);
  assert.ok(Math.abs(tank.vapourJoules / 4.4e6 - 1) < .05, `${tank.vapourJoules / 1e6} MJ`);
  const car = bleveContents(bam, STANDARD_AIR);
  assert.ok(Math.abs(car.vapourKilograms / 2318 - 1) < .03, `${car.vapourKilograms} kg`);
  assert.ok(Math.abs(car.vapourJoules / 314e6 - 1) < .03, `${car.vapourJoules / 1e6} MJ`);
  assert.ok(Math.abs(bleveChargeKilograms(bam, STANDARD_AIR) / 134 - 1) < .03);
});

test('only the vapour drives the blast, scaled by the blast share, and a water boiler bursts too', () => {
  const full = { ...defaultBleve(), fillShare: .9 };
  const empty = { ...defaultBleve(), fillShare: .1 };
  assert.ok(bleveChargeKilograms(empty, STANDARD_AIR) > bleveChargeKilograms(full, STANDARD_AIR));
  const half = bleveChargeKilograms({ ...defaultBleve(), blastShare: .5 }, STANDARD_AIR);
  assert.ok(Math.abs(half / bleveChargeKilograms(defaultBleve(), STANDARD_AIR) - .5) < 1e-12);
  const boiler = { ...defaultBleve(), fluid: 'water', vesselCubicMetres: 6, fillShare: .6, failureBar: 12 };
  assert.ok(bleveChargeKilograms(boiler, STANDARD_AIR) > 1);
  const sources = emitterSources(boiler, STANDARD_AIR).sources;
  assert.equal(sources.length, 2);
  assert.ok(sources.every(source => source.pulse === 'friedlander'));
});

test('the BAM rail car is heard about as the Kinney & Graham estimate, above the measured first peaks', () => {
  const measured = { 100: 2500, 150: 1400, 200: 1200 };
  const estimated = { 100: 4500, 150: 2900, 200: 2200 };
  for (const distance of [100, 200]) {
    const heard = heardPeakPa(bam, distance);
    assert.ok(heard > measured[distance] && heard < 2 * estimated[distance], `${distance} m: ${heard} Pa`);
    assert.ok(Math.abs(heard / estimated[distance] - 1) < .3, `${distance} m: ${heard} Pa against ${estimated[distance]} Pa`);
  }
});

test('every vessel preset holds a fluid that fails within its table', () => {
  for (const [type, vessel] of Object.entries(BLEVE.vessels)) {
    for (const fluid of ['propane', 'butane', 'gasoline']) {
      const contents = bleveContents({ fluid, ...vessel }, STANDARD_AIR);
      assert.ok(contents.vapourJoules > 0 && Number.isFinite(contents.liquidKilograms), `${type} ${fluid}`);
    }
  }
});

test('the fireball takes its size and visible duration from Roberts and the CCPS, within the Spadeadam trials', () => {
  const fireball = fireballOf({ ...defaultBleve(), vesselCubicMetres: 4.5, fillShare: .85 * 1708 / 1932, failureBar: 23.4 }, STANDARD_AIR);
  assert.ok(Math.abs(fireball.kilograms / 1708 - 1) < .15, `${fireball.kilograms} kg`);
  const measured = { diameterMetres: [71, 85], visibleSeconds: [6.6, 7] };
  assert.ok(fireball.diameterMetres > .8 * measured.diameterMetres[0] && fireball.diameterMetres < 1.2 * measured.diameterMetres[1]);
  assert.ok(fireball.visibleSeconds > .75 * measured.visibleSeconds[0] && fireball.visibleSeconds < measured.visibleSeconds[1]);
  const large = fireballOf({ ...defaultBleve(), vesselCubicMetres: 1600 }, STANDARD_AIR);
  assert.ok(Math.abs(large.visibleSeconds - 2.6 * large.kilograms ** (1 / 6)) < 1e-9);
  assert.equal(fireballOf({ ...defaultBleve(), fluid: 'water' }, STANDARD_AIR), null);
});

test('the roar starts at the vessel, follows the heat release, and goes off with its level, the thump going on', () => {
  const [roar] = fireballRoarSources(defaultBleve(), STANDARD_AIR);
  const fireball = fireballOf(defaultBleve(), STANDARD_AIR);
  assert.equal(roar.pulse, 'noise');
  assert.deepEqual(roar.positionMetres, defaultBleve().positionMetres);
  assert.ok(Math.abs(roar.durationSeconds - .33 * fireball.kilograms ** (1 / 6)) < 1e-9);
  const [quieter] = fireballRoarSources({ ...defaultBleve(), fireballDecibels: -6 }, STANDARD_AIR);
  assert.ok(Math.abs(20 * Math.log10(roar.amplitudePaMetres / quieter.amplitudePaMetres) - 6) < 1e-9);
  assert.deepEqual(fireballRoarSources({ ...defaultBleve(), fireballDecibels: -60 }, STANDARD_AIR).map(source => source.noiseSeed), [thumpSeed(defaultBleve())]);
  assert.equal(emitterSources({ ...defaultBleve(), fluid: 'water' }, STANDARD_AIR).sources.length, 2);
  assert.equal(emitterSources(defaultBleve(), STANDARD_AIR).sources.length, 4);
  assert.equal(fireballRoarSources({ ...defaultBleve(), swellDecibels: -12 }, STANDARD_AIR).length, 3);
});

test('the growing fireball swells as a monopole as large as Betteridge & Phillips measured, peaking early in its growth', () => {
  const lng = { kilograms: 681, diameterMetres: 4.8 * Math.cbrt(681), holdSeconds: 1.2 };
  const swell = fireballSwell(lng, STANDARD_AIR);
  assert.ok(Math.abs(2 * swell.peakPaMetres / 100 / 300 - 1) < .1, `${2 * swell.peakPaMetres / 100} Pa at 100 m`);
  assert.ok(swell.onsetSeconds < swell.positiveSeconds && swell.positiveSeconds < lng.holdSeconds);
  const swellOf = emitter => fireballRoarSources(emitter, STANDARD_AIR).find(source => source.pulse === 'friedlander');
  const [louder, quieter] = [swellOf({ ...defaultBleve(), swellDecibels: 0 }), swellOf({ ...defaultBleve(), swellDecibels: -12 })];
  assert.ok(Math.abs(20 * Math.log10(louder.amplitudePaMetres / quieter.amplitudePaMetres) - 12) < 1e-9);
});

function bandEnergy(samples, sampleRate, [lowHz, highHz], [fromSeconds, toSeconds]) {
  const size = nextPowerOfTwo(samples.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(samples);
  fft(re, im);
  for (let bin = 0; bin < size; bin += 1) {
    const frequencyHz = Math.min(bin, size - bin) * sampleRate / size;
    if (frequencyHz < lowHz || frequencyHz >= highHz) { re[bin] = 0; im[bin] = 0; }
  }
  fft(re, im, true);
  let sum = 0;
  for (let index = Math.round(fromSeconds * sampleRate); index < Math.round(toSeconds * sampleRate); index += 1) sum += re[index] ** 2;
  return sum;
}

test('the roar darkens high over its hold, its puffs shared by both noise parts', () => {
  const [sampleRate, hold] = [8000, 1.6];
  let darkening = 0;
  for (const seed of [1, 2, 3, 4]) {
    const roar = fireballRoarSamples(seed, hold, sampleRate);
    darkening += 10 * Math.log10(bandEnergy(roar, sampleRate, [1000, 4000], [.05, .35]) / bandEnergy(roar, sampleRate, [1000, 4000], [1.3, 1.6])) / 4;
  }
  assert.ok(darkening > 6, `high band darkens ${darkening} dB`);
  const envelope = samples => Array.from({ length: 30 }, (_, step) => Math.log(bandEnergy(samples, sampleRate, [20, 4000], [step * .08, (step + 1) * .08]) + 1e-30));
  const correlation = (a, b) => {
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    const [ma, mb] = [mean(a), mean(b)];
    const dot = (x, mx, y, my) => x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0);
    return dot(a, ma, b, mb) / Math.sqrt(dot(a, ma, a, ma) * dot(b, mb, b, mb));
  };
  const [first, second] = [fireballRoarSamples(10, hold, sampleRate, 10), fireballRoarSamples(11, hold, sampleRate, 10)];
  assert.notDeepEqual(first.slice(0, 100), second.slice(0, 100));
  assert.ok(correlation(envelope(first), envelope(second)) > .8);
});

test('the roar, the thump and the swell are each their own source, at their own level and off on their own', () => {
  const sources = emitter => fireballRoarSources(emitter, STANDARD_AIR);
  const all = sources(defaultBleve());
  const thump = all.find(source => source.noiseSeed === thumpSeed(defaultBleve()));
  assert.ok(thump && Math.abs(thump.amplitudePaMetres - thumpPaMetres(fireballOf(defaultBleve(), STANDARD_AIR), STANDARD_AIR)) < 1e-9);
  const quieter = sources({ ...defaultBleve(), thumpDecibels: -6 }).find(source => source.noiseSeed === thump.noiseSeed);
  assert.ok(Math.abs(20 * Math.log10(thump.amplitudePaMetres / quieter.amplitudePaMetres) - 6) < 1e-9);
  const roarless = sources({ ...defaultBleve(), fireballDecibels: -60, swellDecibels: 0 });
  assert.equal(roarless.find(source => source.noiseSeed === thump.noiseSeed).amplitudePaMetres, thump.amplitudePaMetres);
  assert.ok(roarless.some(source => source.pulse === 'friedlander'));
  assert.equal(sources({ ...defaultBleve(), thumpDecibels: -60 }).filter(source => source.noiseSeed === thump.noiseSeed).length, 0);
  assert.equal(sources({ ...defaultBleve(), fluid: 'water' }).length, 0);
});

test('the thump is one low burst early in the growth, gone well before the fireball has grown', () => {
  const [sampleRate, hold] = [8000, 1.6];
  let drop = 0;
  for (const seed of [1, 2, 3, 4]) {
    const thump = fireballThumpSamples(seed, hold, sampleRate);
    drop += 10 * Math.log10(bandEnergy(thump, sampleRate, [40, 160], [0, .5]) / bandEnergy(thump, sampleRate, [40, 160], [.9, 1.5])) / 4;
  }
  assert.ok(drop > 20, `${drop} dB down by the second half of the growth`);
});

test('the thump bursts as the growth accelerates most, at a time and level of its seed, and its hold stays under the burst', () => {
  const [sampleRate, hold] = [8000, 1.6];
  const peaks = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const thumping = fireballThumpSamples(seed, hold, sampleRate);
    const windows = Array.from({ length: 32 }, (_, step) => bandEnergy(thumping, sampleRate, [40, 160], [step * .05, (step + 1) * .05]));
    const onset = Math.max(...windows.slice(0, 10));
    peaks.push(windows.indexOf(onset));
    assert.ok(Math.max(...windows.slice(16, 32)) < onset, `seed ${seed}: the hold rises over the burst`);
  }
  assert.ok(new Set(peaks).size > 1, `burst windows ${peaks}`);
});

function bangOverRoarDecibels(emitter, distance) {
  const scene = plainScene('blast');
  scene.emitters = [emitter];
  scene.receivers[0].positionMetres = { x: distance, y: 0, z: 1.7 };
  const value = parseScene(scene);
  const { samples, sampleRate } = renderReceiver(prepareScene(value), value.receivers[0], value);
  const largest = samples.reduce((most, sample) => Math.max(most, Math.abs(sample)), 0);
  const first = samples.findIndex(sample => Math.abs(sample) > 1e-4 * largest);
  const hold = fireballOf(emitter, STANDARD_AIR).holdSeconds;
  let sum = 0;
  const [from, to] = [first + Math.round(.3 * sampleRate), first + Math.round((.1 + hold) * sampleRate)];
  for (let index = from; index < to; index += 1) sum += samples[index] ** 2;
  return 20 * Math.log10(largest / Math.sqrt(sum / (to - from)));
}

test('a road tanker heard 125 m away bangs above its roar by more than the level-managed recordings E9 and E11', () => {
  const decibels = bangOverRoarDecibels(defaultBleve(), 125);
  assert.ok(decibels > 14 && decibels < 35, `${decibels} dB`);
});

test('a small vessel bursting at low pressure is heard as its bang, its fireball held to half its visible duration', () => {
  const can = { ...defaultBleve(), fluid: 'gasoline', vesselCubicMetres: .01, fillShare: 0, failureBar: 1 };
  const fireball = fireballOf(can, STANDARD_AIR);
  assert.ok(Math.abs(fireball.holdSeconds - fireball.visibleSeconds / 2) < 1e-12);
  const [roar] = fireballRoarSources(can, STANDARD_AIR);
  assert.ok(roar.spanSeconds < 2 * fireball.visibleSeconds);
  assert.ok(heardPeakPa(can, 100) < 1.5 * heardPeakPa({ ...can, fireballDecibels: -60 }, 100));
});

test('a vessel bursts in two strong shocks, the second about 90 ms after the first for a 2000 l tank, as Birk et al. measured', () => {
  const tank = { ...defaultBleve(), vesselCubicMetres: 2, fillShare: .65, failureBar: 18 };
  const [first, second] = emitterSources(tank, STANDARD_AIR).sources;
  assert.equal(second.pulse, 'friedlander');
  assert.ok(Math.abs(second.amplitudePaMetres / first.amplitudePaMetres - .8) < 1e-9);
  const delay = second.emissionSeconds - first.emissionSeconds;
  assert.ok(delay > .07 && delay < .12, `${delay} s`);
});
