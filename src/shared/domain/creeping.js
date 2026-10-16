import { airy, divide, multiply } from './airy.js';
import { PROPAGATION } from './constants.js';
import { delanyBazleyImpedance } from './ground.js';

/** Class B for the mode (verify against Pierce, Acoustics, 1981, ch. 9, and Berry & Daigle 1988); the soft-ground transition's shape class C. */

const RIGID_ROOT = -1.018792971647471;
const SOFT_ROOT = -2.338107410459767;
export const SOFT_RATIO = SOFT_ROOT / RIGID_ROOT;
const ROTATION = [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)];
const Q_ROTATION = [Math.cos(5 * Math.PI / 6), Math.sin(5 * Math.PI / 6)];
const CONTINUATION_STEPS = 12;
const NEWTON_ITERATIONS = 30;
const ROOT_TOLERANCE = 1e-12;
const SWEEP_LOWEST_HZ = 1;
const SWEEP_HIGHEST_HZ = 20000;
const SWEEP_POINTS = 80;
const FOLLOW_STEP = 1.1;

export function modeRoot(q, start) {
  let t = start;
  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const [value, slope] = airy(t);
    const qValue = multiply(q, value);
    const tValue = multiply(t, value);
    const qSlope = multiply(q, slope);
    const step = divide([slope[0] + qValue[0], slope[1] + qValue[1]], [tValue[0] + qSlope[0], tValue[1] + qSlope[1]]);
    t = [t[0] - step[0], t[1] - step[1]];
    if (!Number.isFinite(t[0]) || !Number.isFinite(t[1])) return null;
    if (Math.hypot(...step) < ROOT_TOLERANCE) return t;
  }
  return null;
}

function impedanceParameter(frequencyHz, flowResistivity, speed, radiusMetres) {
  const [zRe, zIm] = delanyBazleyImpedance(frequencyHz, flowResistivity);
  const scale = zRe * zRe + zIm * zIm;
  const beta = [zRe / scale, -zIm / scale];
  const size = Math.cbrt(Math.PI * frequencyHz / speed * radiusMetres);
  return multiply(Q_ROTATION, beta).map(value => value * size);
}

export function creepingLossRatios(frequencies, flowResistivity, speed, radiusMetres) {
  const rigidLoss = ROTATION[1] * RIGID_ROOT;
  let root = null;
  let previous = 1;
  let reached = 0;
  return Float64Array.from(frequencies, frequency => {
    const q = impedanceParameter(frequency, flowResistivity, speed, radiusMetres);
    // Across a wide gap the root is followed in small steps, or Newton may settle on a higher mode.
    for (let between = reached * FOLLOW_STEP; root && reached && between < frequency; between *= FOLLOW_STEP) {
      root = modeRoot(impedanceParameter(between, flowResistivity, speed, radiusMetres), root);
    }
    reached = frequency;
    if (root) root = modeRoot(q, root);
    if (!root) {
      root = [RIGID_ROOT, 0];
      for (let step = 1; step <= CONTINUATION_STEPS && root; step += 1) root = modeRoot(q.map(value => value * step / CONTINUATION_STEPS), root);
    }
    const ratio = root ? multiply(ROTATION, root)[1] / rigidLoss : NaN;
    if (!(ratio > 0)) { root = null; return previous; }
    previous = ratio;
    return ratio;
  });
}

export function creepingTransitionHz(flowResistivity, speed, radiusMetres) {
  const frequencies = Float64Array.from({ length: SWEEP_POINTS }, (_, index) => SWEEP_LOWEST_HZ * (SWEEP_HIGHEST_HZ / SWEEP_LOWEST_HZ) ** (index / (SWEEP_POINTS - 1)));
  const ratios = creepingLossRatios(frequencies, flowResistivity, speed, radiusMetres);
  const half = (1 + SOFT_RATIO) / 2;
  if (ratios[0] >= half) return PROPAGATION.shadowRegularizationHz;
  for (let index = 1; index < SWEEP_POINTS; index += 1) {
    if (ratios[index] < half) continue;
    const share = (half - ratios[index - 1]) / (ratios[index] - ratios[index - 1]);
    return Math.max(PROPAGATION.shadowRegularizationHz, frequencies[index - 1] * (frequencies[index] / frequencies[index - 1]) ** share);
  }
  return SWEEP_HIGHEST_HZ;
}

/** [loss, lag] in the e^(+iωt) convention of `fft.js`. */
export function cubeRootExponent(frequencyHz, cutoffHz) {
  const omega = 2 * Math.PI * frequencyHz;
  const cutoff = 2 * Math.PI * cutoffHz;
  const size = omega * Math.hypot(cutoff, omega) ** (-2 / 3);
  const angle = Math.PI / 2 - 2 / 3 * Math.atan2(omega, cutoff);
  return [size * Math.cos(angle), size * Math.sin(angle)];
}

/** [loss, lag] in the e^(+iωt) convention of `fft.js`. */
export function softExponent(frequencyHz, transitionHz) {
  const [loss, lag] = cubeRootExponent(frequencyHz, transitionHz);
  return [(SOFT_RATIO - 1) * loss, (SOFT_RATIO - 1) * lag];
}
