import { flashSources, lightningEmitterFlashes } from './lightning.js';
import { friedlanderSpanSeconds } from './pulses.js';
import { stormFlashes } from './storm.js';

export const EMITTER_KINDS = Object.freeze(['lightning', 'storm', 'blast']);

/** Class B: Kinney & Graham (1985) peak overpressure fit, ΔP/P = f(Z) with Z in m/kg^(1/3). */
const KINNEY_GRAHAM = Object.freeze({ scale: 808, numerator: 4.5, denominators: [.048, .32, 1.35] });

export function kinneyGrahamOverpressureRatio(scaledDistance) {
  const { scale, numerator, denominators } = KINNEY_GRAHAM;
  const top = scale * (1 + (scaledDistance / numerator) ** 2);
  return top / denominators.reduce((product, value) => product * Math.sqrt(1 + (scaledDistance / value) ** 2), 1);
}

/**
 * A blast as one point source with a Friedlander waveform. Its amplitude comes from the Kinney &
 * Graham fit at the linearization scaled distance, from where propagation is linear (class B).
 * The positive phase scales with the cube root of the charge (Hopkinson–Cranz, class B) from a
 * reference duration (class C until the Kinney & Graham duration fit is verified).
 */
export function blastSources(emitter, air) {
  const cubeRoot = Math.cbrt(emitter.chargeKilograms);
  const linearRadiusMetres = emitter.linearScaledDistance * cubeRoot;
  const overpressurePa = air.pressureKpa * 1000 * kinneyGrahamOverpressureRatio(emitter.linearScaledDistance);
  const durationSeconds = emitter.durationSecondsPerCubeRootKilogram * cubeRoot;
  return [{
    flash: 0,
    positionMetres: emitter.positionMetres,
    direction: null,
    elementMetres: 0,
    emissionSeconds: emitter.startSeconds,
    amplitudePaMetres: overpressurePa * linearRadiusMetres,
    pulse: 'friedlander',
    durationSeconds,
    decay: emitter.decay,
    spanSeconds: friedlanderSpanSeconds(durationSeconds, emitter.decay),
    linearRadiusMetres
  }];
}

/** Channels and strokes of an emitter; a blast has none. Deterministic from the emitter. */
export function emitterFlashes(emitter) {
  if (emitter.kind === 'lightning') return lightningEmitterFlashes(emitter);
  if (emitter.kind === 'storm') return stormFlashes(emitter);
  return [];
}

/** Point sources of an emitter, with the flashes they came from. */
export function emitterSources(emitter, air) {
  if (emitter.kind === 'blast') return { flashes: [], sources: blastSources(emitter, air) };
  const flashes = emitterFlashes(emitter);
  return { flashes, sources: flashSources(flashes, emitter, air) };
}
