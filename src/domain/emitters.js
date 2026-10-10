import { flashSources, lightningEmitterFlashes } from './lightning.js';
import { barrageRounds } from './barrage.js';
import { SECONDARY_MASS_SHARE, secondaryShockFactors } from './explosives.js';
import { flightMembers } from './flight.js';
import { meteorSources, showerMembers } from './meteor.js';
import { fireballSpanSeconds } from './fireball.js';
import { friedlanderSpanSeconds } from './pulses.js';
import { stormFlashes } from './storm.js';
import { onGround } from './terrain.js';

export const EMITTER_KINDS = Object.freeze(['lightning', 'storm', 'blast', 'barrage', 'flight', 'formation', 'meteor', 'shower']);

/** Class B: Kinney & Graham (1985) peak overpressure fit, ΔP/P = f(Z) with Z in m/kg^(1/3). */
const KINNEY_GRAHAM = Object.freeze({ scale: 808, numerator: 4.5, denominators: [.048, .32, 1.35] });

export function kinneyGrahamOverpressureRatio(scaledDistance) {
  const { scale, numerator, denominators } = KINNEY_GRAHAM;
  const top = scale * (1 + (scaledDistance / numerator) ** 2);
  return top / denominators.reduce((product, value) => product * Math.sqrt(1 + (scaledDistance / value) ** 2), 1);
}

/**
 * A blast as point sources at one place: its shock, its secondary shock, and its roar. The shock is a
 * Friedlander pulse whose amplitude comes from the Kinney & Graham fit at the linearization scaled
 * distance, from where propagation is linear (class B). The positive phase scales with the cube
 * root of the charge (Hopkinson–Cranz, class B) from a reference duration (class C until the
 * Kinney & Graham duration fit is verified). The secondary shock is the same pulse of a smaller
 * charge, delayed per path by the explosive's fit (`explosives.js`); the roar is a seeded noise
 * burst at a level against the shock's amplitude at the same distance (`fireball.js`).
 */
/**
 * A flight as one row: the renderer finds its booms per receiver from its path (`flight.js`), which
 * set where and when each leaves, its overpressure, and its duration. The row keeps the N-wave pulse.
 */
function flightSource(flight) {
  return {
    flash: 0, positionMetres: flight.startMetres, direction: null, elementMetres: 0, emissionSeconds: flight.startSeconds,
    amplitudePaMetres: 1, pulse: 'n-wave', durationSeconds: .1, decay: 0, spanSeconds: 0, linearRadiusMetres: 0, flight: true
  };
}

/** The Fireball level at which a blast has no roar. */
export const FIREBALL_OFF_DECIBELS = -60;

export function blastSources(emitter, air, surface = null) {
  const positionMetres = surface ? onGround(surface, emitter.positionMetres) : emitter.positionMetres;
  const shock = kilograms => {
    const cubeRoot = Math.cbrt(kilograms);
    const linearRadiusMetres = emitter.linearScaledDistance * cubeRoot;
    const overpressurePa = air.pressureKpa * 1000 * kinneyGrahamOverpressureRatio(emitter.linearScaledDistance);
    const durationSeconds = emitter.durationSecondsPerCubeRootKilogram * cubeRoot;
    return {
      flash: 0, positionMetres, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds,
      amplitudePaMetres: overpressurePa * linearRadiusMetres,
      pulse: 'friedlander', durationSeconds, decay: emitter.decay,
      spanSeconds: friedlanderSpanSeconds(durationSeconds, emitter.decay),
      linearRadiusMetres
    };
  };
  const primary = shock(emitter.chargeKilograms);
  const secondary = { ...shock(SECONDARY_MASS_SHARE * emitter.chargeKilograms), secondaryShock: secondaryShockFactors(emitter.explosive, emitter.chargeKilograms) };
  // A large fireball burns as its buoyancy lifts it, in a time that grows as the sixth root of its mass
  // (Fay & Lewis 1976); a momentum-driven one as the cube root (Roberts 1981). The roar follows the
  // first (class C), from 1.2 s at 5 kg as fitted to the recordings to about 9 s at 1 000 t.
  const roarSeconds = emitter.fireballSecondsPerSixthRootKilogram * emitter.chargeKilograms ** (1 / 6);
  const roar = {
    flash: 0, positionMetres, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds,
    amplitudePaMetres: 10 ** (emitter.fireballDecibels / 20) * primary.amplitudePaMetres,
    pulse: 'noise', noiseSeed: emitter.seed, durationSeconds: roarSeconds, decay: 0,
    spanSeconds: fireballSpanSeconds(roarSeconds), linearRadiusMetres: 0
  };
  // The roar's lowest level means none; the secondary shock can be switched off.
  return [primary, ...(emitter.secondaryShock ? [secondary] : []), ...(emitter.fireballDecibels > FIREBALL_OFF_DECIBELS ? [roar] : [])];
}

/**
 * Channels and strokes of an emitter over a terrain surface (flat ground when null); a blast has
 * none. Deterministic from the emitter and the surface.
 */
export function emitterFlashes(emitter, surface = null) {
  if (emitter.kind === 'lightning') return lightningEmitterFlashes(emitter, surface);
  if (emitter.kind === 'storm') return stormFlashes(emitter, surface);
  return [];
}

/** Point sources of an emitter, with the flashes they came from. */
export function emitterSources(emitter, air, surface = null) {
  if (emitter.kind === 'blast') return { flashes: [], sources: blastSources(emitter, air, surface) };
  if (emitter.kind === 'meteor' || emitter.kind === 'shower') return { flashes: [], sources: showerMembers(emitter).flatMap((meteor, index) => meteorSources(meteor, air, index)) };
  if (emitter.kind === 'flight' || emitter.kind === 'formation') return { flashes: [], sources: flightMembers(emitter).map(flightSource) };
  if (emitter.kind === 'barrage') return { flashes: [], sources: barrageRounds(emitter).flatMap(round => blastSources(round, air, surface)) };
  const flashes = emitterFlashes(emitter, surface);
  return { flashes, sources: flashSources(flashes, emitter, air) };
}
