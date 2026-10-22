/** Class B: Kinney & Graham (1985) peak overpressure fit, ΔP/P = f(Z) with Z in m/kg^(1/3). */
const KINNEY_GRAHAM = Object.freeze({ scale: 808, numerator: 4.5, denominators: [.048, .32, 1.35] });

export function kinneyGrahamOverpressureRatio(scaledDistance) {
  const { scale, numerator, denominators } = KINNEY_GRAHAM;
  const top = scale * (1 + (scaledDistance / numerator) ** 2);
  return top / denominators.reduce((product, value) => product * Math.sqrt(1 + (scaledDistance / value) ** 2), 1);
}

export const BLAST_PULSE = Object.freeze({ linearScaledDistance: 20, durationSecondsPerCubeRootKilogram: .006, decay: 1 });

const STANDARD_PRESSURE_PA = 101325;

/** ∫p²dt of the Friedlander pulse (1 − t/T)·e^(−bt/T), per peak² and T. */
export function friedlanderEnergyShare(decay) {
  const rate = 2 * decay;
  return 1 / rate - 2 / rate ** 2 + 2 / rate ** 3;
}

const blastPaMetresPerCubeRootKilogram = () => STANDARD_PRESSURE_PA * kinneyGrahamOverpressureRatio(BLAST_PULSE.linearScaledDistance) * BLAST_PULSE.linearScaledDistance;

const blastExposurePerKilogram = () =>
  blastPaMetresPerCubeRootKilogram() ** 2 * BLAST_PULSE.durationSecondsPerCubeRootKilogram * friedlanderEnergyShare(BLAST_PULSE.decay);

export const blastPressureAtKilometrePa = kilograms => blastPaMetresPerCubeRootKilogram() * Math.cbrt(kilograms) / 1000;

/** Class C: a pulse sized as the Blast charge whose primary shock carries the same sound energy in standard air. */
export const equivalentChargeKilograms = (paMetres, pulseSeconds, decay) =>
  paMetres ** 2 * pulseSeconds * friedlanderEnergyShare(decay) / blastExposurePerKilogram();

export const paMetresOfEquivalentCharge = (kilograms, pulseSeconds, decay) =>
  Math.sqrt(kilograms * blastExposurePerKilogram() / (pulseSeconds * friedlanderEnergyShare(decay)));
