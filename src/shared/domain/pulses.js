/** Pulses are Pa·m at 1 m; spectra use the forward convention of `fft.js`, τ = 0 at the front. */

const RISE_TIME_PER_SIGMA = 2.5631;
const SMALL_ARGUMENT = 1e-4;

/** Class C: the shock front is smoothed by a zero-phase Gaussian with the given 10–90 % rise time. */
export function riseSmoothing(frequencyHz, riseTimeSeconds) {
  const sigma = riseTimeSeconds / RISE_TIME_PER_SIGMA;
  return Math.exp(-2 * (Math.PI * sigma * frequencyHz) ** 2);
}

/** Class B. */
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

/** Class C as a shape; the middle shock's share and ratio come with the source. */
export function tripleSpectrum(frequencyHz, durationSeconds, middleShare, middleRatio) {
  const [nRe, nIm] = nWaveSpectrum(frequencyHz, durationSeconds);
  const omega = 2 * Math.PI * frequencyHz;
  const x = omega * durationSeconds;
  if (Math.abs(x) < SMALL_ARGUMENT) return [0, nIm - omega * middleRatio * durationSeconds ** 2 * (1 - middleShare) * (3 * middleShare - 1) / 6];
  return tripleTerm(omega, Math.cos(x), Math.sin(x), Math.cos(x * middleShare), Math.sin(x * middleShare), nRe, nIm, middleShare, middleRatio);
}

export function tripleTerm(omega, cosine, sine, middleCosine, middleSine, nRe, nIm, middleShare, middleRatio) {
  const rest = 1 - middleShare;
  return [
    nRe + middleRatio * ((sine - middleSine) / omega - rest * (sine / omega - nRe)),
    nIm + middleRatio * ((cosine - middleCosine) / omega - rest * ((cosine - 1) / omega - nIm))
  ];
}

/** Class B. */
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

export const friedlanderSpanSeconds = (positiveDurationSeconds, decay) =>
  positiveDurationSeconds * (1 + Math.log(1e6) / decay);

const N_WAVE_PEAK_OMEGA_DURATION = (() => {
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

export const nWaveDurationForPeak = peakFrequencyHz => N_WAVE_PEAK_OMEGA_DURATION / (2 * Math.PI * peakFrequencyHz);
