import { airy, divide, multiply } from './airy.js';
import { delanyBazleyImpedance } from './ground.js';

/**
 * The creeping mode of the refraction shadow over an impedance ground (class B for the mode, derived
 * here; the rigid limit is the Fock form in `refraction.js`, to verify against Pierce, Acoustics,
 * 1981, ch. 9, and Berry & Daigle 1988).
 *
 * With n² ≈ 1 + 2z/R near the ground, R = c₀/|g|, and time e^(−iωt), the mode p = φ(z)·e^(iκx) that
 * radiates upward is φ = Ai(e^(−iπ/3)·s·(z + z₀)), s = (2k²/R)^(1/3). The ground's normalized
 * admittance β gives φ′(0) + ikβ·φ(0) = 0, so the mode's root t = e^(−iπ/3)·s·z₀ solves
 *   Ai′(t) + q·Ai(t) = 0,   q = e^(i5π/6)·β·(kR/2)^(1/3),
 * and κ − k = −m·e^(iπ/3)·t with m = (k/2)^(1/3)·R^(−2/3). On rigid ground (q = 0) t is the first
 * zero of Ai′, −1.01879; as |q| grows, which any finite impedance does at high frequencies because
 * grazing sound reflects from it as from a pressure-release surface, t moves to the first zero of
 * Ai, −2.33811, and the loss grows SOFT_RATIO times.
 *
 * Scaling the rigid loss and lag by the mode's ratios frequency by frequency breaks the link between
 * loss and phase that causality demands: measured, sound arrived 30–50 dB below the peak before the
 * path's arrival time. Multiplying the rigid exponent by a causal M(s) = 1 + (ρ − 1)·s/(s + ω_t)
 * kept it causal but turned part of the loss below ω_t into gain (measured +9.6 dB at 5–20 Hz over
 * snow at 20 km). The render therefore adds to the rigid exponent E₀(s) = s·(s + ω_c)^(−2/3) a second
 * term of the same causal form, (SOFT_RATIO − 1)·s·(s + ω_t)^(−2/3): its real part is never negative,
 * so soft ground never attenuates less than rigid; it is a pure delay well below the transition
 * frequency ω_t/2π and makes the whole SOFT_RATIO·s^(1/3) well above it. The transition is where the
 * mode's loss ratio lies halfway between the two (class C for the shape between them).
 */

const RIGID_ROOT = -1.018792971647471;
const SOFT_ROOT = -2.338107410459767;
export const SOFT_RATIO = SOFT_ROOT / RIGID_ROOT;
const ROTATION = [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)];
const Q_ROTATION = [Math.cos(5 * Math.PI / 6), Math.sin(5 * Math.PI / 6)];
/** Newton on the mode condition, reached from the rigid root in this many steps of q. */
const CONTINUATION_STEPS = 12;
const NEWTON_ITERATIONS = 30;
const ROOT_TOLERANCE = 1e-12;
/** Frequencies searched for the transition, spaced evenly in log. */
const SWEEP_LOWEST_HZ = 1;
const SWEEP_HIGHEST_HZ = 20000;
const SWEEP_POINTS = 80;
/** Largest ratio between frequencies at which the root is followed. */
const FOLLOW_STEP = 1.1;
/** The transition is kept at or above this, the rigid response's regularization frequency (`render.js`). */
export const TRANSITION_FLOOR_HZ = 5;

/** The root of Ai′(t) + q·Ai(t) = 0 nearest `start` by Newton, or null if it does not converge. */
export function modeRoot(q, start) {
  let t = start;
  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const [value, slope] = airy(t);
    // F = Ai′ + q·Ai, F′ = Ai″ + q·Ai′ = t·Ai + q·Ai′.
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

/** q for a ground of the given flow resistivity at a frequency, a ground speed, and a refraction radius R. */
export function impedanceParameter(frequencyHz, flowResistivity, speed, radiusMetres) {
  const [zRe, zIm] = delanyBazleyImpedance(frequencyHz, flowResistivity);
  const scale = zRe * zRe + zIm * zIm;
  const beta = [zRe / scale, -zIm / scale];
  const size = Math.cbrt(Math.PI * frequencyHz / speed * radiusMetres);
  return multiply(Q_ROTATION, beta).map(value => value * size);
}

/**
 * The mode's loss over the ground relative to rigid ground at each of the given ascending
 * frequencies, following the root from the rigid one so that it stays on the least attenuated mode.
 */
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

/**
 * The transition frequency in hertz where the mode's loss over the ground rises halfway from rigid
 * to pressure-release, interpolated in log frequency, and at least TRANSITION_FLOOR_HZ.
 */
export function creepingTransitionHz(flowResistivity, speed, radiusMetres) {
  const frequencies = Float64Array.from({ length: SWEEP_POINTS }, (_, index) => SWEEP_LOWEST_HZ * (SWEEP_HIGHEST_HZ / SWEEP_LOWEST_HZ) ** (index / (SWEEP_POINTS - 1)));
  const ratios = creepingLossRatios(frequencies, flowResistivity, speed, radiusMetres);
  const half = (1 + SOFT_RATIO) / 2;
  if (ratios[0] >= half) return TRANSITION_FLOOR_HZ;
  for (let index = 1; index < SWEEP_POINTS; index += 1) {
    if (ratios[index] < half) continue;
    const share = (half - ratios[index - 1]) / (ratios[index] - ratios[index - 1]);
    return Math.max(TRANSITION_FLOOR_HZ, frequencies[index - 1] * (frequencies[index] / frequencies[index - 1]) ** share);
  }
  return SWEEP_HIGHEST_HZ;
}

/**
 * (SOFT_RATIO − 1)·s·(s + ω_t)^(−2/3) at s = iω, as [loss, lag] in the e^(+iωt) convention of
 * `fft.js`, to add to the rigid exponent.
 */
export function softExponent(frequencyHz, transitionHz) {
  const omega = 2 * Math.PI * frequencyHz;
  const cutoff = 2 * Math.PI * transitionHz;
  const size = (SOFT_RATIO - 1) * omega * Math.hypot(cutoff, omega) ** (-2 / 3);
  const angle = Math.PI / 2 - 2 / 3 * Math.atan2(omega, cutoff);
  return [size * Math.cos(angle), size * Math.sin(angle)];
}
