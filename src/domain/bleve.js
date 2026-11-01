import { BLAST_PULSE } from './blast-pulse.js';
import { BLAST, BLEVE } from './constants.js';
import { onsetAmplitude, positivePhaseShare, pulseSource } from './gas-explosion.js';
import { scaleToLoudestWindow, spectralNoise, spectralNoisePair, tableDensity } from './fireball.js';
import { speedOfSoundMetresPerSecond } from '../shared/domain/air.js';
import { nextPowerOfTwo } from '../shared/domain/fft.js';
import { createRandom, normalDeviate } from '../shared/domain/random.js';
import { drawPuffs, puffLayerWeights, puffPowerAt, puffPowers } from './roar-puffs.js';
import { onGround } from '../shared/domain/terrain.js';

export const FLUID_TYPES = Object.freeze(Object.keys(BLEVE.fluids));
export const VESSEL_TYPES = Object.freeze(Object.keys(BLEVE.vessels));
export const VESSEL_NUMBERS = Object.freeze(['vesselCubicMetres', 'fillShare', 'failureBar']);

const FIREBALL_OFF_DECIBELS = -60;
const STANDARD_AIR = Object.freeze({ pressureKpa: 101.325, temperatureCelsius: 15 });

export function applyVessel(item, type) {
  for (const key of VESSEL_NUMBERS) item[key] = BLEVE.vessels[type][key];
}

export const vesselOf = item => VESSEL_TYPES.find(type => VESSEL_NUMBERS.every(key => item[key] === BLEVE.vessels[type][key])) ?? 'custom';

/** Class A within the table, between rows on a log pressure scale; held at its ends. */
export function saturation(fluid, absoluteBar) {
  const rows = BLEVE.fluids[fluid].saturation;
  const bar = Math.min(rows.at(-1)[0], Math.max(rows[0][0], absoluteBar));
  let upper = 1;
  while (upper < rows.length - 1 && rows[upper][0] < bar) upper += 1;
  const [low, high] = [rows[upper - 1], rows[upper]];
  const share = Math.log(bar / low[0]) / Math.log(high[0] / low[0]);
  const [, celsius, liquidKilogramsPerCubicMetre, vapourKilogramsPerCubicMetre, vapourKilojoulesPerKilogram] = low.map((value, index) => value + share * (high[index] - value));
  return { bar, celsius, liquidKilogramsPerCubicMetre, vapourKilogramsPerCubicMetre, vapourKilojoulesPerKilogram };
}

/** Class A: the saturated contents at failure; class B: the blast takes the vapour's isentropic expansion work only (Birk et al. 2007). */
export function bleveContents(emitter, air) {
  const state = saturation(emitter.fluid, emitter.failureBar + air.pressureKpa / 100);
  const liquidKilograms = emitter.fillShare * emitter.vesselCubicMetres * state.liquidKilogramsPerCubicMetre;
  const vapourKilograms = (1 - emitter.fillShare) * emitter.vesselCubicMetres * state.vapourKilogramsPerCubicMetre;
  return { ...state, liquidKilograms, vapourKilograms, vapourJoules: vapourKilograms * state.vapourKilojoulesPerKilogram * 1000 };
}

/** Class B: the Yellow Book's A_sb = 2 for a vessel on the ground. */
export const bleveChargeKilograms = (emitter, air) => 2 * emitter.blastShare * bleveContents(emitter, air).vapourJoules / (BLEVE.tntMegajoulesPerKilogram * 1e6);

/** Class B far from the vessel (R̄ > 2), conservative near it: a vessel burst's blast as a TNT charge of the same energy; its second shock timed as TNT's (class C). */
export const bleveBlast = (emitter, air) => ({
  kind: 'blast', seed: emitter.seed, startSeconds: emitter.startSeconds, positionMetres: emitter.positionMetres,
  chargeKilograms: bleveChargeKilograms(emitter, air), explosive: 'tnt', secondaryShock: false,
  linearScaledDistance: BLAST_PULSE.linearScaledDistance, durationSecondsPerCubeRootKilogram: BLAST_PULSE.durationSecondsPerCubeRootKilogram, decay: BLAST_PULSE.decay,
  riseTimeSeconds: emitter.riseTimeSeconds, fireballDecibels: FIREBALL_OFF_DECIBELS, fireballSecondsPerSixthRootKilogram: 0
});

/** Class B: the whole contents burn as one fireball (Roberts 1982, CCPS 1994); its roar holds for k M^⅙ or half the visible duration (class C). */
export function fireballOf(emitter, air) {
  const heat = BLEVE.fluids[emitter.fluid].combustionMegajoulesPerKilogram;
  if (!(heat > 0)) return null;
  const contents = bleveContents(emitter, air);
  const kilograms = contents.liquidKilograms + contents.vapourKilograms;
  const { diameterMetresPerCubeRootKilogram, secondsPerCubeRootKilogram, largeKilograms, largeSecondsPerSixthRootKilogram, holdShareOfVisible } = BLEVE.fireball;
  const visibleSeconds = kilograms < largeKilograms ? secondsPerCubeRootKilogram * Math.cbrt(kilograms) : largeSecondsPerSixthRootKilogram * kilograms ** (1 / 6);
  return {
    kilograms, visibleSeconds, diameterMetres: diameterMetresPerCubeRootKilogram * Math.cbrt(kilograms),
    holdSeconds: Math.min(emitter.fireballSecondsPerSixthRootKilogram * kilograms ** (1 / 6), holdShareOfVisible * visibleSeconds), heatWatts: kilograms * heat * 1e6 / visibleSeconds
  };
}

/** Class C: the loudest window's p·r of a hemisphere radiating the acoustic share of the mean heat release, halved because the ground doubles it. */
export function roarPaMetres(fireball, air) {
  const density = air.pressureKpa * 1000 / (287.05 * (air.temperatureCelsius + 273.15));
  const watts = BLEVE.fireball.acousticEfficiency * fireball.heatWatts;
  return Math.sqrt(watts * density * speedOfSoundMetresPerSecond(air.temperatureCelsius) / (2 * Math.PI)) / 2;
}

const roarRiseSeconds = holdSeconds => Math.min(BLEVE.fireball.riseSeconds, BLEVE.fireball.riseShareOfHold * holdSeconds);

export const roarSpanSeconds = holdSeconds => roarRiseSeconds(holdSeconds) + holdSeconds * (1 + 70 / BLEVE.fireball.tailDecibels);

const roarDensity = tableDensity(BLEVE.fireball.spectrumHz, BLEVE.fireball.spectrumDensity);

const layerWeights = puffLayerWeights(BLEVE.fireball.puffs.crossoversHz);

const layerDensities = layerWeights.map(share => frequencyHz => share(frequencyHz) * roarDensity(frequencyHz));

const thumpDensity = tableDensity(BLEVE.fireball.thump.spectrumHz, BLEVE.fireball.thump.spectrumDensity);

const BURST_SEED = 0x2545f491;
const THUMP_SEED = 0x6c8e9cf5;

export const thumpSeed = emitter => (emitter.seed ^ THUMP_SEED) >>> 0;
let lastEnvelopes = null;

function roarEnvelopes(puffSeed, holdSeconds, sampleRate) {
  const key = `${puffSeed}:${holdSeconds}:${sampleRate}`;
  if (lastEnvelopes?.key === key) return lastEnvelopes;
  const { tailDecibels, puffs: config } = BLEVE.fireball;
  const { floorDecibels, darkeningDecibels } = config;
  const riseSeconds = roarRiseSeconds(holdSeconds);
  const length = Math.ceil(roarSpanSeconds(holdSeconds) * sampleRate);
  const puffs = drawPuffs(createRandom(puffSeed), riseSeconds + holdSeconds, holdSeconds, config, layerWeights.length);
  const decay = tailDecibels / 20 * Math.LN10 / holdSeconds;
  const burnSeconds = riseSeconds + holdSeconds;
  const layers = layerDensities.map(() => new Float64Array(length));
  const puffPower = puffPowers(puffs, layers.length, length, sampleRate, floorDecibels);
  let plainEnergy = 0;
  const layerEnergy = new Float64Array(layers.length);
  for (let index = 0; index < length; index += 1) {
    const t = index / sampleRate;
    const envelope = t < riseSeconds ? t / riseSeconds : t < burnSeconds ? 1 : Math.exp(-decay * (t - burnSeconds));
    plainEnergy += envelope ** 2;
    const burnt = Math.min(t, burnSeconds) / burnSeconds;
    for (let layer = 0; layer < layers.length; layer += 1) {
      const power = puffPowerAt(puffPower[layer], index);
      const tilt = 10 ** (-darkeningDecibels[layer] * burnt / 20);
      const value = envelope * tilt * Math.sqrt(power);
      layerEnergy[layer] += value ** 2;
      layers[layer][index] = value;
    }
  }
  layers.forEach((shaped, layer) => {
    const scale = layerEnergy[layer] > 0 ? Math.sqrt(plainEnergy / layerEnergy[layer]) : 0;
    for (let index = 0; index < length; index += 1) shaped[index] = scale * shaped[index];
  });
  lastEnvelopes = { key, length, layers };
  return lastEnvelopes;
}

const loudestWindow = sampleRate => Math.max(1, Math.round(BLAST.roar.windowSeconds * sampleRate));

/** Class C: overlapping puffs, drawn from the vessel's seed so that both noise parts share them, over noise drawn from each part's seed. */
export function fireballRoarSamples(seed, holdSeconds, sampleRate, puffSeed = seed) {
  const { length, layers } = roarEnvelopes(puffSeed, holdSeconds, sampleRate);
  const random = createRandom(seed);
  const size = nextPowerOfTwo(length);
  const noises = [...spectralNoisePair(random, size, sampleRate, layerDensities), spectralNoise(random, size, sampleRate, layerDensities[2])];
  const samples = new Float64Array(length);
  for (let layer = 0; layer < noises.length; layer += 1) {
    for (let index = 0; index < length; index += 1) samples[index] += layers[layer][index] * noises[layer][index];
  }
  return scaleToLoudestWindow(samples, loudestWindow(sampleRate));
}

/** Class C: the growth thump, one burst as the fireball's growth accelerates most, at a level and time of the vessel's seed. */
export function fireballThumpSamples(seed, holdSeconds, sampleRate, puffSeed = seed) {
  const { burstSpreadDecibels, burstTimeSpread } = BLEVE.fireball.thump;
  const length = Math.ceil(roarSpanSeconds(holdSeconds) * sampleRate);
  const shape = createRandom((puffSeed ^ BURST_SEED) >>> 0);
  const level = 10 ** (burstSpreadDecibels * normalDeviate(shape) / 20);
  const burstSeconds = (2 - Math.SQRT2) * holdSeconds / BLEVE.fireball.swell.growthRate * Math.exp(burstTimeSpread * normalDeviate(shape));
  const noise = spectralNoise(createRandom(seed), nextPowerOfTwo(length), sampleRate, thumpDensity);
  const samples = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const x = index / sampleRate / burstSeconds;
    samples[index] = (x * Math.exp(1 - x)) ** 2 * noise[index];
  }
  scaleToLoudestWindow(samples, loudestWindow(sampleRate));
  for (let index = 0; index < length; index += 1) samples[index] *= level;
  return samples;
}

/** Class C like the thump itself: its loudest window, a turbulent share of the swell's peak. */
export const thumpPaMetres = (fireball, air) => BLEVE.fireball.thump.turbulentShare * fireballSwell(fireball, air).peakPaMetres;

export const ownsNoise = (emitter, seed) => [emitter.seed, thumpSeed(emitter)].some(own => (seed - own) >>> 0 <= 1);

export const bleveNoiseSamples = (seed, holdSeconds, sampleRate, emitter) => ((seed - thumpSeed(emitter)) >>> 0 <= 1
  ? fireballThumpSamples(seed, holdSeconds, sampleRate, emitter.seed)
  : fireballRoarSamples(seed, holdSeconds, sampleRate, emitter.seed));

export const fireballDiameterMetres = emitter => fireballOf(emitter, STANDARD_AIR)?.diameterMetres ?? 0;

const SWELL_PEAK_SHARE = (2 - Math.SQRT2) / 2;

const swellOnsetShare = (() => {
  let [low, high] = [0, 1];
  for (let step = 0; step < 50; step += 1) {
    const middle = (low + high) / 2;
    if (middle / positivePhaseShare(middle, BLAST_PULSE.decay) < SWELL_PEAK_SHARE) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
})();

/** Class B level and timing; class C shape: the monopole's positive phase as a Friedlander pulse rising to its peak. */
export function fireballSwell(fireball, air) {
  const { expansionRatio, growthRate } = BLEVE.fireball.swell;
  const density = air.pressureKpa * 1000 / (287.05 * (air.temperatureCelsius + 273.15));
  const volume = Math.PI * fireball.diameterMetres ** 3 / 6;
  const rate = growthRate / fireball.holdSeconds;
  const peak = 2 * SWELL_PEAK_SHARE;
  const acceleration = volume * rate ** 2 / 2 * peak * (2 - peak) * Math.exp(-peak);
  const peakPaMetres = density * (1 - 1 / expansionRatio) * acceleration / (4 * Math.PI);
  const positiveSeconds = 2 / rate;
  const decay = BLAST_PULSE.decay;
  const durationSeconds = positiveSeconds / positivePhaseShare(swellOnsetShare, decay);
  const onsetSeconds = swellOnsetShare * durationSeconds;
  return { peakPaMetres, positiveSeconds, onsetSeconds, durationSeconds, decay, amplitudePaMetres: onsetAmplitude(peakPaMetres, onsetSeconds, durationSeconds, decay), agingRadiusMetres: fireball.diameterMetres / 2 };
}

function swellSource(common, swell, decibels, air) {
  const gain = 10 ** (decibels / 20);
  return pulseSource(common, { ...swell, peakPaMetres: gain * swell.peakPaMetres, amplitudePaMetres: gain * swell.amplitudePaMetres }, air);
}

export function fireballRoarSources(emitter, air, surface = null) {
  const fireball = fireballOf(emitter, air);
  if (!fireball) return [];
  const vessel = surface ? onGround(surface, emitter.positionMetres) : emitter.positionMetres;
  const common = { flash: 0, positionMetres: vessel, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds };
  const noise = (paMetres, noiseSeed) => ({
    ...common, amplitudePaMetres: paMetres, pulse: 'noise', noiseSeed,
    durationSeconds: fireball.holdSeconds, decay: 0, spanSeconds: roarSpanSeconds(fireball.holdSeconds), linearRadiusMetres: 0
  });
  return [
    ...(emitter.fireballDecibels > FIREBALL_OFF_DECIBELS ? [noise(10 ** (emitter.fireballDecibels / 20) * roarPaMetres(fireball, air), emitter.seed)] : []),
    ...(emitter.thumpDecibels > FIREBALL_OFF_DECIBELS ? [noise(10 ** (emitter.thumpDecibels / 20) * thumpPaMetres(fireball, air), thumpSeed(emitter))] : []),
    ...(emitter.swellDecibels > FIREBALL_OFF_DECIBELS ? [swellSource(common, fireballSwell(fireball, air), emitter.swellDecibels, air)] : [])
  ];
}
