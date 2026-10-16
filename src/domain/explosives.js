import { BLAST } from './constants.js';

/** Class B: Rigby & Gitterman, MABS 24, 2016, fitted over 0.18 kg–2 472 t and Z from 0.74 to beyond 400 m/kg^⅓; W as TNT equivalent class C. */
export const EXPLOSIVE_TYPES = Object.freeze(Object.keys(BLAST.explosives));

export function secondaryShockFactors(explosive, kilograms) {
  const { densityKgPerCubicMetre, detonationMetresPerSecond } = BLAST.explosives[explosive];
  return { delaySeconds: Math.cbrt(densityKgPerCubicMetre * kilograms) / detonationMetresPerSecond, cubeRootKilograms: Math.cbrt(kilograms) };
}
