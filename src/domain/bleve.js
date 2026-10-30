import { BLAST_PULSE } from './blast-pulse.js';
import { BLEVE } from './constants.js';

export const FLUID_TYPES = Object.freeze(Object.keys(BLEVE.fluids));
export const VESSEL_TYPES = Object.freeze(Object.keys(BLEVE.vessels));
export const VESSEL_NUMBERS = Object.freeze(['vesselCubicMetres', 'fillShare', 'failureBar']);

const FIREBALL_OFF_DECIBELS = -60;

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
