import { BLAST } from './constants.js';

/** Class B: Rigby & Gitterman, MABS 24, 2016, fitted over 0.18 kg–2 472 t and Z from 0.74 to beyond 400 m/kg^⅓; W as TNT equivalent class C. */
export const EXPLOSIVE_TYPES = Object.freeze(Object.keys(BLAST.explosives));

const DELAY_SLOPE = 2.45;
const DELAY_OFFSET = 1.36;
const SMALLEST_SCALED_DISTANCE = .74;

export function secondaryShockFactors(explosive, kilograms) {
  const { densityKgPerCubicMetre, detonationMetresPerSecond } = BLAST.explosives[explosive];
  return { delaySeconds: Math.cbrt(densityKgPerCubicMetre * kilograms) / detonationMetresPerSecond, cubeRootKilograms: Math.cbrt(kilograms) };
}

export function secondaryShockDelay(delaySeconds, cubeRootKilograms, metres) {
  const scaled = Math.max(SMALLEST_SCALED_DISTANCE, metres / cubeRootKilograms);
  return (DELAY_SLOPE * Math.log10(scaled) + DELAY_OFFSET) * delaySeconds;
}
