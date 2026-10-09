/**
 * Source pulses as analytic spectra. Each pulse is a far-field pressure signature scaled to 1 m
 * (Pa·m), so the pressure at distance R is the pulse divided by R. Spectra use the forward
 * convention of `fft.js`: S(f) = ∫ s(τ)·e^(−i2πfτ) dτ, with τ = 0 at the shock front.
 */

/** Gaussian kernel standard deviation per 10–90 % rise time of a smoothed step. */
const RISE_TIME_PER_SIGMA = 2.5631;
const SMALL_ARGUMENT = 1e-4;

/** Class C: the shock front is smoothed by a zero-phase Gaussian with the given 10–90 % rise time. */
export function riseSmoothing(frequencyHz, riseTimeSeconds) {
  const sigma = riseTimeSeconds / RISE_TIME_PER_SIGMA;
  return Math.exp(-2 * (Math.PI * sigma * frequencyHz) ** 2);
}

/**
 * Class B: N-wave p(τ) = P·(1 − 2τ/T) for 0 ≤ τ ≤ T. Returns [re, im] of its spectrum per unit
 * amplitude P.
 */
export function nWaveSpectrum(frequencyHz, durationSeconds) {
  const omega = 2 * Math.PI * frequencyHz;
  const x = omega * durationSeconds;
  if (Math.abs(x) < SMALL_ARGUMENT) return [0, omega * durationSeconds ** 2 / 6];
  const cosine = Math.cos(x);
  const sine = Math.sin(x);
  const firstRe = sine / omega;
  const firstIm = (cosine - 1) / omega;
  const tailRe = 1 - cosine - x * sine;
  const tailIm = sine - x * cosine;
  const scale = 2 / (durationSeconds * omega * omega);
  return [firstRe + scale * tailRe, firstIm + scale * tailIm];
}

/**
 * Class B: Friedlander waveform p(τ) = P·(1 − τ/T₊)·exp(−bτ/T₊), τ ≥ 0. Returns [re, im] of its
 * spectrum per unit amplitude P: 1/s − 1/(T₊·s²) with s = b/T₊ + iω.
 */
export function friedlanderSpectrum(frequencyHz, positiveDurationSeconds, decay) {
  const sRe = decay / positiveDurationSeconds;
  const sIm = 2 * Math.PI * frequencyHz;
  const scale = sRe * sRe + sIm * sIm;
  const inverseRe = sRe / scale;
  const inverseIm = -sIm / scale;
  const inverseSquaredRe = inverseRe * inverseRe - inverseIm * inverseIm;
  const inverseSquaredIm = 2 * inverseRe * inverseIm;
  return [inverseRe - inverseSquaredRe / positiveDurationSeconds, inverseIm - inverseSquaredIm / positiveDurationSeconds];
}

/** Time after the front by which a Friedlander tail has decayed below 10⁻⁶ of its peak. */
export const friedlanderSpanSeconds = (positiveDurationSeconds, decay) =>
  positiveDurationSeconds * (1 + Math.log(1e6) / decay);

/** The dimensionless ωT at which the N-wave amplitude spectrum peaks, by golden-section search. */
export const N_WAVE_PEAK_OMEGA_DURATION = (() => {
  const magnitude = x => Math.hypot(...nWaveSpectrum(x / (2 * Math.PI), 1));
  let low = 1;
  let high = 8;
  const ratio = (Math.sqrt(5) - 1) / 2;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const left = high - ratio * (high - low);
    const right = low + ratio * (high - low);
    if (magnitude(left) < magnitude(right)) low = left; else high = right;
  }
  return (low + high) / 2;
})();

/** N-wave duration whose amplitude spectrum peaks at the given frequency. */
export const nWaveDurationForPeak = peakFrequencyHz => N_WAVE_PEAK_OMEGA_DURATION / (2 * Math.PI * peakFrequencyHz);
