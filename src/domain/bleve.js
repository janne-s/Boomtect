import { BLAST_PULSE } from './blast-pulse.js';
import { BLAST, BLEVE } from './constants.js';
import { onsetAmplitude, positivePhaseShare, pulseSource } from './gas-explosion.js';
import { scaleToLoudestWindow, spectralNoise, spectralNoisePair, tableDensity } from './fireball.js';
import { speedOfSoundMetresPerSecond } from '../shared/domain/air.js';
import { nextPowerOfTwo } from '../shared/domain/fft.js';
import { createRandom, normalDeviate } from '../shared/domain/random.js';
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
  chargeKilograms: bleveChargeKilograms(emitter, air), explosive: 'tnt', secondaryShock: true,
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

const layerWeights = (() => {
  const [low, high] = BLEVE.fireball.puffs.crossoversHz;
  const lowShare = frequencyHz => 1 / (1 + (frequencyHz / low) ** 4);
  const highShare = frequencyHz => 1 / (1 + (high / frequencyHz) ** 4);
  return [lowShare, frequencyHz => Math.max(0, 1 - lowShare(frequencyHz) - highShare(frequencyHz)), highShare];
})();

const layerDensities = layerWeights.map(share => frequencyHz => share(frequencyHz) * roarDensity(frequencyHz));

function drawPuffs(random, riseSeconds, holdSeconds) {
  const { count, onsetPower, shortestShareOfHold, longestShareOfHold, attackShare, spreadDecibels, layerSpreadDecibels, colourDecibels } = BLEVE.fireball.puffs;
  return Array.from({ length: count }, (_, index) => {
    const onsetSeconds = index === 0 ? 0 : (riseSeconds + holdSeconds) * random() ** onsetPower;
    const attackSeconds = attackShare * holdSeconds * (index === 0 ? shortestShareOfHold : shortestShareOfHold + random() * (longestShareOfHold - shortestShareOfHold));
    const decibels = index === 0 ? 0 : spreadDecibels * normalDeviate(random);
    const colour = index === 0 ? 1 : normalDeviate(random);
    const gains = layerWeights.map((_, layer) => 10 ** ((decibels + layerSpreadDecibels * normalDeviate(random) + colourDecibels * colour * (layer - 1)) / 20));
    return { onsetSeconds, attackSeconds, gains };
  });
}

const growthDensity = tableDensity(BLEVE.fireball.growth.spectrumHz, BLEVE.fireball.growth.spectrumDensity);

const PUFF_STEP = 32;
const BURST_SEED = 0x2545f491;
let lastEnvelopes = null;

function roarEnvelopes(puffSeed, holdSeconds, sampleRate, thumping) {
  const key = `${puffSeed}:${holdSeconds}:${sampleRate}:${thumping}`;
  if (lastEnvelopes?.key === key) return lastEnvelopes;
  const { tailDecibels, puffs: { floorDecibels, darkeningDecibels, swellPeakShareOfHold, swellFloor }, growth } = BLEVE.fireball;
  const riseSeconds = roarRiseSeconds(holdSeconds);
  const length = Math.ceil(roarSpanSeconds(holdSeconds) * sampleRate);
  const puffs = drawPuffs(createRandom(puffSeed), riseSeconds, holdSeconds);
  const decay = tailDecibels / 20 * Math.LN10 / holdSeconds;
  const burnSeconds = riseSeconds + holdSeconds;
  const floor = 10 ** (floorDecibels / 20);
  const swellPeakSeconds = swellPeakShareOfHold * holdSeconds;
  const layers = layerDensities.map(() => new Float64Array(length));
  const steps = Math.ceil(length / PUFF_STEP) + 1;
  const puffPower = layers.map((_, layer) => Float64Array.from({ length: steps }, (__, step) => {
    const t = step * PUFF_STEP / sampleRate;
    let power = floor ** 2;
    for (const { onsetSeconds, attackSeconds, gains } of puffs) {
      if (t <= onsetSeconds) continue;
      const x = (t - onsetSeconds) / attackSeconds;
      power += (gains[layer] * x * Math.exp(1 - x)) ** 2;
    }
    return power;
  }));
  const lowPower = thumping ? new Float64Array(length) : null;
  let plainEnergy = 0;
  const layerEnergy = new Float64Array(layers.length);
  for (let index = 0; index < length; index += 1) {
    const t = index / sampleRate;
    const envelope = t < riseSeconds ? t / riseSeconds : t < burnSeconds ? 1 : Math.exp(-decay * (t - burnSeconds));
    plainEnergy += envelope ** 2;
    const burnt = Math.min(t, burnSeconds) / burnSeconds;
    const swelling = t < swellPeakSeconds ? Math.max(swellFloor, t / swellPeakSeconds * Math.exp(1 - t / swellPeakSeconds)) : 1;
    const step = Math.floor(index / PUFF_STEP);
    const share = index / PUFF_STEP - step;
    for (let layer = 0; layer < layers.length; layer += 1) {
      const power = puffPower[layer][step] + share * (puffPower[layer][step + 1] - puffPower[layer][step]);
      if (layer === 0 && thumping) lowPower[index] = power;
      const tilt = (layer === 0 ? swelling : 1) * 10 ** (-darkeningDecibels[layer] * burnt / 20);
      const value = envelope * tilt * Math.sqrt(power);
      layerEnergy[layer] += value ** 2;
      layers[layer][index] = value;
    }
  }
  layers.forEach((shaped, layer) => {
    const scale = layerEnergy[layer] > 0 ? Math.sqrt(plainEnergy / layerEnergy[layer]) : 0;
    for (let index = 0; index < length; index += 1) shaped[index] = scale * shaped[index];
  });
  let thump = null;
  if (thumping) {
    const { endDecibels, endSeconds, burstDecibels, burstSpreadDecibels, burstTimeSpread, puffCeiling, tiltSpreadDecibels } = growth;
    const growthEnd = endDecibels / 20 * Math.LN10 / endSeconds;
    const growing = Math.min(length, Math.round(holdSeconds * sampleRate));
    const meanPower = lowPower.subarray(0, growing).reduce((sum, value) => sum + value, 0) / Math.max(1, growing);
    const shape = createRandom((puffSeed ^ BURST_SEED) >>> 0);
    const burst = 10 ** ((burstDecibels + burstSpreadDecibels * normalDeviate(shape)) / 20);
    const burstSeconds = (2 - Math.SQRT2) * holdSeconds / BLEVE.fireball.swell.growthRate * Math.exp(burstTimeSpread * normalDeviate(shape));
    const tilt = tiltSpreadDecibels * normalDeviate(shape);
    const ceiling = Math.max(1, burst / 10 ** (2 / 20));
    thump = new Float64Array(length);
    for (let index = 0; index < length; index += 1) {
      const t = index / sampleRate;
      const x = t / burstSeconds;
      const bursting = burst * (x * Math.exp(1 - x)) ** 2;
      const holding = Math.min(ceiling, (t < riseSeconds ? t / riseSeconds : 1) * Math.sqrt(1 + Math.min(puffCeiling, lowPower[index] / meanPower)) * 10 ** (tilt * Math.min(t, holdSeconds) / holdSeconds / 20));
      thump[index] = Math.hypot(bursting, holding) * (t < holdSeconds ? 1 : Math.exp(-growthEnd * (t - holdSeconds)));
    }
  }
  lastEnvelopes = { key, length, layers, thump };
  return lastEnvelopes;
}

/**
 * Class C: overlapping puffs, drawn from the vessel's seed so that both noise parts share them, over noise drawn from each part's seed;
 * the growth thump, at `growthShare` of the roar's loudest window, bursts as the fireball's growth accelerates most, then follows the low
 * puffs, held under the burst, until the fireball has grown.
 */
export function fireballRoarSamples(seed, holdSeconds, sampleRate, puffSeed = seed, growthShare = 0) {
  const { length, layers, thump: thumpEnvelope } = roarEnvelopes(puffSeed, holdSeconds, sampleRate, growthShare > 0);
  const random = createRandom(seed);
  const size = nextPowerOfTwo(length);
  const noises = spectralNoisePair(random, size, sampleRate, layerDensities);
  const [high, thump] = growthShare > 0 ? spectralNoisePair(random, size, sampleRate, [layerDensities[2], growthDensity]) : [spectralNoise(random, size, sampleRate, layerDensities[2]), null];
  noises.push(high);
  const samples = new Float64Array(length);
  for (let layer = 0; layer < noises.length; layer += 1) {
    for (let index = 0; index < length; index += 1) samples[index] += layers[layer][index] * noises[layer][index];
  }
  const window = Math.max(1, Math.round(BLAST.roar.windowSeconds * sampleRate));
  scaleToLoudestWindow(samples, window);
  if (!thump) return samples;
  for (let index = 0; index < length; index += 1) thump[index] *= thumpEnvelope[index];
  const thumping = scaleToLoudestWindow(thump.subarray(0, length), window);
  for (let index = 0; index < length; index += 1) samples[index] += growthShare * thumping[index];
  return samples;
}

/** The growth thump's loudest window over the roar's, as both sources are set; standard air, class C like the thump itself. */
export function growthShareOf(emitter) {
  const fireball = fireballOf(emitter, STANDARD_AIR);
  if (!fireball || emitter.growthDecibels <= FIREBALL_OFF_DECIBELS) return 0;
  const thump = BLEVE.fireball.growth.turbulentShare * fireballSwell(fireball, STANDARD_AIR).peakPaMetres;
  return 10 ** ((emitter.growthDecibels - emitter.fireballDecibels) / 20) * thump / roarPaMetres(fireball, STANDARD_AIR);
}

export const bleveRoarSamples = (seed, holdSeconds, sampleRate, emitter) => fireballRoarSamples(seed, holdSeconds, sampleRate, emitter.seed, growthShareOf(emitter));

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
  if (!fireball || emitter.fireballDecibels <= FIREBALL_OFF_DECIBELS) return [];
  const ground = surface ? onGround(surface, emitter.positionMetres) : emitter.positionMetres;
  const common = { flash: 0, positionMetres: { ...ground, z: ground.z + fireball.diameterMetres / 2 }, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds };
  return [{
    ...common, amplitudePaMetres: 10 ** (emitter.fireballDecibels / 20) * roarPaMetres(fireball, air), pulse: 'noise', noiseSeed: emitter.seed,
    durationSeconds: fireball.holdSeconds, decay: 0, spanSeconds: roarSpanSeconds(fireball.holdSeconds), linearRadiusMetres: 0
  }, ...(emitter.swellDecibels > FIREBALL_OFF_DECIBELS ? [swellSource(common, fireballSwell(fireball, air), emitter.swellDecibels, air)] : [])];
}
