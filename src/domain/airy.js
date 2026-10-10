/**
 * The Airy function Ai and its derivative for complex arguments, by their power series
 * Ai(z) = c₁f(z) − c₂g(z) (Abramowitz & Stegun 10.4.2–10.4.3), which in double precision keep at
 * least ten significant digits for |z| ≤ 4, where the creeping-mode roots lie. Complex numbers are
 * [re, im] pairs.
 */

const AI_ZERO = 0.355028053887817239;
const AI_PRIME_ZERO = 0.258819403792806798;
const SERIES_TERMS = 60;

export const multiply = ([a, b], [c, d]) => [a * c - b * d, a * d + b * c];
export const divide = ([a, b], [c, d]) => {
  const scale = c * c + d * d;
  return [(a * c + b * d) / scale, (b * c - a * d) / scale];
};

/** [Ai(z), Ai′(z)]. */
export function airy(z) {
  const square = multiply(z, z);
  const cube = multiply(square, z);
  // f = Σ aₖ z^{3k} and g = Σ bₖ z^{3k+1}, with aₖ = aₖ₋₁/((3k−1)·3k) and bₖ = bₖ₋₁/(3k·(3k+1)).
  let a = 1;
  let b = 1;
  let power = [1, 0];
  let f = [1, 0];
  let g = z;
  let fPrime = [0, 0];
  let gPrime = [1, 0];
  for (let k = 1; k < SERIES_TERMS; k += 1) {
    a /= (3 * k - 1) * (3 * k);
    b /= (3 * k) * (3 * k + 1);
    const previous = power;
    power = multiply(previous, cube);
    const withZ = multiply(power, z);
    const fall = multiply(previous, square);
    f = [f[0] + a * power[0], f[1] + a * power[1]];
    g = [g[0] + b * withZ[0], g[1] + b * withZ[1]];
    fPrime = [fPrime[0] + 3 * k * a * fall[0], fPrime[1] + 3 * k * a * fall[1]];
    gPrime = [gPrime[0] + (3 * k + 1) * b * power[0], gPrime[1] + (3 * k + 1) * b * power[1]];
    if ((Math.abs(a) + Math.abs(b)) * Math.hypot(...power) < 1e-18) break;
  }
  return [
    [AI_ZERO * f[0] - AI_PRIME_ZERO * g[0], AI_ZERO * f[1] - AI_PRIME_ZERO * g[1]],
    [AI_ZERO * fPrime[0] - AI_PRIME_ZERO * gPrime[0], AI_ZERO * fPrime[1] - AI_PRIME_ZERO * gPrime[1]]
  ];
}
