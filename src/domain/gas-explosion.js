import { BLAST_PULSE, blastPressureAtKilometrePa } from './blast-pulse.js';
import { GAS_EXPLOSION } from './constants.js';
import { fireballSpanSeconds } from './fireball.js';
import { friedlanderSpanSeconds } from '../shared/domain/pulses.js';
import { onGround } from '../shared/domain/terrain.js';

export const FUEL_TYPES = Object.freeze(Object.keys(GAS_EXPLOSION.fuels));
export const CONGESTION_TYPES = Object.freeze(Object.keys(GAS_EXPLOSION.congestions));
export const CONFINEMENT_TYPES = Object.freeze(Object.keys(GAS_EXPLOSION.confinements));
export const IGNITION_TYPES = Object.freeze(Object.keys(GAS_EXPLOSION.ignitions));

const FIREBALL_OFF_DECIBELS = -60;

/** Class C: congestion and confinement set the Multi-Energy strength, the fuel's reactivity shifts it, and a burster charge detonates the cloud. */
export function gasStrength(emitter) {
  if (emitter.ignition === 'charge') return GAS_EXPLOSION.detonationStrength;
  const { fuels, congestions, confinements, detonationStrength } = GAS_EXPLOSION;
  const strength = congestions[emitter.congestion].strength + confinements[emitter.confinement].strength + fuels[emitter.fuel].reactivity;
  return Math.min(detonationStrength, Math.max(1, strength));
}

export const cloudRadiusMetres = cubicMetres => Math.cbrt(3 * cubicMetres / (2 * Math.PI));

export const combustionJoules = emitter => GAS_EXPLOSION.fuels[emitter.fuel].megajoulesPerCubicMetre * 1e6 * emitter.cloudCubicMetres;

export const gasEquivalentKilograms = emitter => combustionJoules(emitter) / (GAS_EXPLOSION.tntMegajoulesPerKilogram * 1e6);

/** Class A for a weak deflagration: an expanding flame at speed S gives 2ρ(1 − 1/σ)S² at its edge. */
export function flameMetresPerSecond(sourcePa, air) {
  const density = air.pressureKpa * 1000 / (287.05 * (air.temperatureCelsius + 273.15));
  return Math.sqrt(sourcePa / (2 * density * (1 - 1 / GAS_EXPLOSION.expansionRatio)));
}

const friedlanderArea = (seconds, durationSeconds, decay) => {
  const integral = u => Math.exp(-decay * u) * ((u - 1) / decay + 1 / decay ** 2);
  return durationSeconds * (integral(seconds / durationSeconds) - integral(0));
};

/** Class B level: the Multi-Energy source pressure falls as 1/R from the cloud's edge, never above the TNT blast of the same energy; halved because the ground doubles it. Class C shape: the pulse rises over the burn time while the wave is a pressure wave, and is a shock from strength 7. */
export function gasExplosionPulse(emitter, air) {
  const strength = gasStrength(emitter);
  const sourcePa = GAS_EXPLOSION.strengthPressuresKpa[strength - 1] * 1000;
  const radiusMetres = cloudRadiusMetres(emitter.cloudCubicMetres);
  const kilograms = gasEquivalentKilograms(emitter);
  const peakPaMetres = Math.min(sourcePa * radiusMetres / 2, blastPressureAtKilometrePa(kilograms) * 1000);
  const burnSeconds = radiusMetres / flameMetresPerSecond(sourcePa, air);
  const [soft, sharp] = GAS_EXPLOSION.pressureWaveStrengths;
  const onsetSeconds = burnSeconds * Math.min(1, Math.max(0, (sharp - strength) / (sharp - soft)));
  const durationSeconds = Math.max(BLAST_PULSE.durationSecondsPerCubeRootKilogram * Math.cbrt(kilograms), burnSeconds);
  const decay = BLAST_PULSE.decay;
  const onsetPeak = onsetSeconds > 0 ? friedlanderArea(onsetSeconds, durationSeconds, decay) / onsetSeconds : 1;
  return { strength, sourcePa, radiusMetres, kilograms, peakPaMetres, burnSeconds, onsetSeconds, durationSeconds, decay, amplitudePaMetres: peakPaMetres / onsetPeak };
}

export const gasPaMetres = (emitter, air) => gasExplosionPulse(emitter, air).peakPaMetres;

export function gasExplosionSources(emitter, air, surface = null) {
  const positionMetres = surface ? onGround(surface, emitter.positionMetres) : emitter.positionMetres;
  const pulse = gasExplosionPulse(emitter, air);
  const common = { flash: 0, positionMetres, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds };
  const shock = {
    ...common, amplitudePaMetres: pulse.amplitudePaMetres, pulse: 'friedlander', durationSeconds: pulse.durationSeconds, onsetSeconds: pulse.onsetSeconds, decay: pulse.decay,
    spanSeconds: friedlanderSpanSeconds(pulse.durationSeconds, pulse.decay),
    linearRadiusMetres: pulse.peakPaMetres / (GAS_EXPLOSION.linearPressureShare * air.pressureKpa * 1000)
  };
  const roarSeconds = emitter.fireballSecondsPerSixthRootKilogram * pulse.kilograms ** (1 / 6) + pulse.burnSeconds;
  const roar = {
    ...common, amplitudePaMetres: 10 ** (emitter.fireballDecibels / 20) * pulse.peakPaMetres, pulse: 'noise', noiseSeed: emitter.seed,
    durationSeconds: roarSeconds, decay: 0, spanSeconds: fireballSpanSeconds(roarSeconds), linearRadiusMetres: 0
  };
  return emitter.fireballDecibels > FIREBALL_OFF_DECIBELS ? [shock, roar] : [shock];
}
