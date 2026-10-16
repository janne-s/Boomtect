import { PROPAGATION } from './constants.js';
import { nWaveDurationForPeak } from './pulses.js';

const DELAY_SLOPE = 2.45;
const DELAY_OFFSET = 1.36;
const SMALLEST_SCALED_DISTANCE = .74;

export function weakShockPulse(relaxationRadius, sourcePeriodSeconds, metres, limitRadii) {
  const { startRadii, periodGrowth, periodExponent, extraDecayExponent } = PROPAGATION.weakShock;
  const x = Math.min(limitRadii, Math.max(startRadii, metres / relaxationRadius));
  const period = periodGrowth * sourcePeriodSeconds * x ** periodExponent;
  return {
    durationSeconds: nWaveDurationForPeak(1 / period),
    amplitudeScale: (x / startRadii) ** extraDecayExponent
  };
}

/** Class B: Rigby & Gitterman, MABS 24, 2016, fitted over 0.18 kg–2 472 t and Z from 0.74 to beyond 400 m/kg^⅓. */
export function secondaryShockDelay(delaySeconds, cubeRootKilograms, metres) {
  const scaled = Math.max(SMALLEST_SCALED_DISTANCE, metres / cubeRootKilograms);
  return (DELAY_SLOPE * Math.log10(scaled) + DELAY_OFFSET) * delaySeconds;
}
