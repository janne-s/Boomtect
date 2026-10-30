import { BLAST_PULSE } from './blast-pulse.js';
import { BLAST, BLEVE } from './constants.js';
import { scaleToLoudestWindow, spectralNoise, tableDensity } from './fireball.js';
import { speedOfSoundMetresPerSecond } from '../shared/domain/air.js';
import { nextPowerOfTwo } from '../shared/domain/fft.js';
import { createRandom } from '../shared/domain/random.js';
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

/** Class B: the whole contents burn as one fireball (Roberts 1982, CCPS 1994); its roar holds for k M^⅙ (class C). */
export function fireballOf(emitter, air) {
  const heat = BLEVE.fluids[emitter.fluid].combustionMegajoulesPerKilogram;
  if (!(heat > 0)) return null;
  const contents = bleveContents(emitter, air);
  const kilograms = contents.liquidKilograms + contents.vapourKilograms;
  const { diameterMetresPerCubeRootKilogram, secondsPerCubeRootKilogram, largeKilograms, largeSecondsPerSixthRootKilogram } = BLEVE.fireball;
  const visibleSeconds = kilograms < largeKilograms ? secondsPerCubeRootKilogram * Math.cbrt(kilograms) : largeSecondsPerSixthRootKilogram * kilograms ** (1 / 6);
  return {
    kilograms, visibleSeconds, diameterMetres: diameterMetresPerCubeRootKilogram * Math.cbrt(kilograms),
    holdSeconds: emitter.fireballSecondsPerSixthRootKilogram * kilograms ** (1 / 6), heatWatts: kilograms * heat * 1e6 / visibleSeconds
  };
}

/** Class C: the loudest window's p·r of a hemisphere radiating the acoustic share of the mean heat release, halved because the ground doubles it. */
export function roarPaMetres(fireball, air) {
  const density = air.pressureKpa * 1000 / (287.05 * (air.temperatureCelsius + 273.15));
  const watts = BLEVE.fireball.acousticEfficiency * fireball.heatWatts;
  return Math.sqrt(watts * density * speedOfSoundMetresPerSecond(air.temperatureCelsius) / (2 * Math.PI)) / 2;
}

export const roarSpanSeconds = holdSeconds => BLEVE.fireball.riseSeconds + holdSeconds * (1 + 70 / BLEVE.fireball.tailDecibels);

const roarDensity = tableDensity(BLEVE.fireball.spectrumHz, BLEVE.fireball.spectrumDensity);

export function fireballRoarSamples(seed, holdSeconds, sampleRate) {
  const { riseSeconds, tailDecibels } = BLEVE.fireball;
  const length = Math.ceil(roarSpanSeconds(holdSeconds) * sampleRate);
  const noise = spectralNoise(createRandom(seed), nextPowerOfTwo(length), sampleRate, roarDensity);
  const decay = tailDecibels / 20 * Math.LN10 / holdSeconds;
  const samples = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const t = index / sampleRate;
    const envelope = t < riseSeconds ? t / riseSeconds : t < riseSeconds + holdSeconds ? 1 : Math.exp(-decay * (t - riseSeconds - holdSeconds));
    samples[index] = noise[index] * envelope;
  }
  return scaleToLoudestWindow(samples, Math.max(1, Math.round(BLAST.roar.windowSeconds * sampleRate)));
}

export const fireballDiameterMetres = emitter => fireballOf(emitter, STANDARD_AIR)?.diameterMetres ?? 0;

export function fireballRoarSources(emitter, air, surface = null) {
  const fireball = fireballOf(emitter, air);
  if (!fireball || emitter.fireballDecibels <= FIREBALL_OFF_DECIBELS) return [];
  const ground = surface ? onGround(surface, emitter.positionMetres) : emitter.positionMetres;
  return [{
    flash: 0, positionMetres: { ...ground, z: ground.z + fireball.diameterMetres / 2 }, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds,
    amplitudePaMetres: 10 ** (emitter.fireballDecibels / 20) * roarPaMetres(fireball, air), pulse: 'noise', noiseSeed: emitter.seed,
    durationSeconds: fireball.holdSeconds, decay: 0, spanSeconds: roarSpanSeconds(fireball.holdSeconds), linearRadiusMetres: 0
  }];
}
