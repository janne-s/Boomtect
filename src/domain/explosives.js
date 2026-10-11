import { BLAST } from './constants.js';

/**
 * Explosives and their secondary shock. After detonation, rarefaction waves collapse inward from the
 * edge of the product cloud, reflect at its centre, and leave as a second, weaker shock that follows
 * the primary one into its negative phase.
 *
 * Class B: Rigby & Gitterman, "Secondary shock delay measurements from explosive trials", MABS 24,
 * 2016 (densities and detonation velocities in BLAST.explosives). Their least-squares fit over
 * hemispherical surface charges of 0.18 kg to 2 472 t at scaled distances of about 0.74 to beyond
 * 400 m/kg^⅓ (Figure 5, checked against its worked example):
 *   t_ss·V_od / (ρ·W)^⅓ = 2.45·log₁₀(Z) + 1.36,  Z = R / W^⅓,
 * with the delay t_ss in seconds, V_od in m/s, ρ in kg/m³, and W the explosive's own mass in kg.
 * Boomtect takes W as the charge's TNT equivalent (class C; equivalences vary from 0.74 to 1.37 with
 * the method), which moves the delay by the cube root of the equivalence.
 */
export const EXPLOSIVE_TYPES = Object.freeze(Object.keys(BLAST.explosives));

const DELAY_SLOPE = 2.45;
const DELAY_OFFSET = 1.36;
/** The smallest scaled distance of the fit's data, m/kg^⅓. */
const SMALLEST_SCALED_DISTANCE = .74;

/**
 * The delay's two factors for a charge: (ρ·W)^⅓ / V_od in seconds and W^⅓ in kg^⅓. Point sources
 * carry them, so that each path's delay follows from its own length.
 */
export function secondaryShockFactors(explosive, kilograms) {
  const { densityKgPerCubicMetre, detonationMetresPerSecond } = BLAST.explosives[explosive];
  return { delaySeconds: Math.cbrt(densityKgPerCubicMetre * kilograms) / detonationMetresPerSecond, cubeRootKilograms: Math.cbrt(kilograms) };
}

/** Seconds from the primary to the secondary shock after `metres`, from a charge's factors. */
export function secondaryShockDelay(delaySeconds, cubeRootKilograms, metres) {
  const scaled = Math.max(SMALLEST_SCALED_DISTANCE, metres / cubeRootKilograms);
  return (DELAY_SLOPE * Math.log10(scaled) + DELAY_OFFSET) * delaySeconds;
}
