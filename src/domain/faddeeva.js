import { fft } from './fft.js';

/** Weideman, SIAM J. Numer. Anal. 31, 1994. */
const TERMS = 32;
const M = 2 * TERMS;
const M2 = 2 * M;
const L = Math.sqrt(TERMS / Math.SQRT2);
const INVERSE_SQRT_PI = 1 / Math.sqrt(Math.PI);

const COEFFICIENTS = (() => {
  const samples = new Float64Array(M2);
  for (let k = -M + 1; k <= M - 1; k += 1) {
    const t = L * Math.tan(k * Math.PI / M / 2);
    samples[k + M] = Math.exp(-t * t) * (L * L + t * t);
  }
  const real = new Float64Array(M2);
  const imaginary = new Float64Array(M2);
  for (let index = 0; index < M2; index += 1) real[index] = samples[(index + M) % M2];
  fft(real, imaginary);
  const coefficients = new Float64Array(TERMS);
  for (let index = 0; index < TERMS; index += 1) coefficients[index] = real[TERMS - index] / M2;
  return coefficients;
})();

function upperHalfPlane(re, im) {
  const denominatorRe = L + im;
  const denominatorIm = -re;
  const numeratorRe = L - im;
  const numeratorIm = re;
  const scale = denominatorRe * denominatorRe + denominatorIm * denominatorIm;
  const zRe = (numeratorRe * denominatorRe + numeratorIm * denominatorIm) / scale;
  const zIm = (numeratorIm * denominatorRe - numeratorRe * denominatorIm) / scale;
  let polyRe = 0;
  let polyIm = 0;
  for (const coefficient of COEFFICIENTS) {
    const nextRe = polyRe * zRe - polyIm * zIm + coefficient;
    polyIm = polyRe * zIm + polyIm * zRe;
    polyRe = nextRe;
  }
  const inverseRe = denominatorRe / scale;
  const inverseIm = -denominatorIm / scale;
  const inverseSquaredRe = inverseRe * inverseRe - inverseIm * inverseIm;
  const inverseSquaredIm = 2 * inverseRe * inverseIm;
  return [
    2 * (polyRe * inverseSquaredRe - polyIm * inverseSquaredIm) + INVERSE_SQRT_PI * inverseRe,
    2 * (polyRe * inverseSquaredIm + polyIm * inverseSquaredRe) + INVERSE_SQRT_PI * inverseIm
  ];
}

export function faddeeva(re, im) {
  if (im >= 0) return upperHalfPlane(re, im);
  const [mirroredRe, mirroredIm] = upperHalfPlane(-re, -im);
  const exponentRe = im * im - re * re;
  const exponentIm = -2 * re * im;
  const magnitude = 2 * Math.exp(exponentRe);
  return [magnitude * Math.cos(exponentIm) - mirroredRe, magnitude * Math.sin(exponentIm) - mirroredIm];
}
