/**
 * Explosives and their secondary shock. After detonation, rarefaction waves collapse inward from the
 * edge of the product cloud, reflect at its centre, and leave as a second, weaker shock that follows
 * the primary one into its negative phase.
 *
 * Class B: packing density and velocity of detonation from Rigby & Gitterman, "Secondary shock delay
 * measurements from explosive trials", MABS 24, 2016, Table 1 (ANFO the middle of its ranges). Its
 * least-squares fit over hemispherical surface charges of 0.18 kg to 2 472 t at scaled distances of
 * about 0.74 to beyond 400 m/kg^⅓ (Figure 5, checked against its worked example):
 *   t_ss·V_od / (ρ·W)^⅓ = 2.45·log₁₀(Z) + 1.36,  Z = R / W^⅓,
 * with the delay t_ss in seconds, V_od in m/s, ρ in kg/m³, and W the explosive's own mass in kg.
 * Boomtect takes W as the charge's TNT equivalent (class C; equivalences vary from 0.74 to 1.37 with
 * the method), which moves the delay by the cube root of the equivalence.
 */
export const EXPLOSIVES = Object.freeze({
  tnt: Object.freeze({ label: 'TNT', densityKgPerCubicMetre: 1630, detonationMetresPerSecond: 6930 }),
  pe4: Object.freeze({ label: 'PE4 / C4', densityKgPerCubicMetre: 1601, detonationMetresPerSecond: 8193 }),
  compB: Object.freeze({ label: 'Composition B', densityKgPerCubicMetre: 1717, detonationMetresPerSecond: 7980 }),
  petn: Object.freeze({ label: 'PETN', densityKgPerCubicMetre: 1770, detonationMetresPerSecond: 8300 }),
  anfo: Object.freeze({ label: 'ANFO', densityKgPerCubicMetre: 825, detonationMetresPerSecond: 4325 })
});
export const EXPLOSIVE_TYPES = Object.freeze(Object.keys(EXPLOSIVES));

const DELAY_SLOPE = 2.45;
const DELAY_OFFSET = 1.36;
/** The smallest scaled distance of the fit's data, m/kg^⅓. */
const SMALLEST_SCALED_DISTANCE = .74;

/**
 * Class B/C: the secondary shock loads like a smaller charge of 3.2–4.9 % of the mass (empirical
 * model fitted to 58 tests with PE4, PE8, and PE10, Shock Waves 2024, doi 10.1007/s00193-024-01208-y;
 * from its abstract). Boomtect radiates it as a Friedlander pulse of that charge.
 */
export const SECONDARY_MASS_SHARE = .04;

/**
 * The delay's two factors for a charge: (ρ·W)^⅓ / V_od in seconds and W^⅓ in kg^⅓. Point sources
 * carry them, so that each path's delay follows from its own length.
 */
export function secondaryShockFactors(explosive, kilograms) {
  const { densityKgPerCubicMetre, detonationMetresPerSecond } = EXPLOSIVES[explosive];
  return { delaySeconds: Math.cbrt(densityKgPerCubicMetre * kilograms) / detonationMetresPerSecond, cubeRootKilograms: Math.cbrt(kilograms) };
}

/** Seconds from the primary to the secondary shock after `metres`, from a charge's factors. */
export function secondaryShockDelay(delaySeconds, cubeRootKilograms, metres) {
  const scaled = Math.max(SMALLEST_SCALED_DISTANCE, metres / cubeRootKilograms);
  return (DELAY_SLOPE * Math.log10(scaled) + DELAY_OFFSET) * delaySeconds;
}
