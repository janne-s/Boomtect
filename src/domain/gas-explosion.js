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

const BAR_PA = 1e5;

/** Class B: the GAME correlation for a spark in the cloud's centre, the flame's path its radius; a burster charge detonates the cloud. */
export function gasSourcePa(emitter) {
  const { strengthPressuresKpa: pressures, congestions, confinements, fuels } = GAS_EXPLOSION;
  const [weakest, strongest] = [pressures[0] * 1000, pressures.at(-1) * 1000];
  if (emitter.ignition === 'charge') return strongest;
  const { blockageRatio, obstacleMetres } = congestions[emitter.congestion];
  const { coefficient, exponent } = confinements[emitter.confinement];
  const argument = blockageRatio * cloudRadiusMetres(emitter.cloudCubicMetres) / obstacleMetres;
  const bar = coefficient * argument ** exponent * fuels[emitter.fuel].burningMetresPerSecond ** 2.7 * obstacleMetres ** .7;
  return Math.min(strongest, Math.max(weakest, bar * BAR_PA));
}

/** The Multi-Energy strength 1–10 whose source pressure this is, between classes on a log scale. */
export function strengthOfPa(sourcePa) {
  const pressures = GAS_EXPLOSION.strengthPressuresKpa.map(kpa => kpa * 1000);
  const upper = Math.min(pressures.length - 1, Math.max(1, pressures.findIndex(pressure => pressure >= sourcePa)));
  return upper + Math.log(sourcePa / pressures[upper - 1]) / Math.log(pressures[upper] / pressures[upper - 1]);
}

export const gasStrength = emitter => strengthOfPa(gasSourcePa(emitter));

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

/** Class B level: the source pressure falls as 1/R from the cloud's edge, never above the TNT blast of the same energy; halved because the ground doubles it. Class C shape: the pulse rises over the burn time while the wave is a pressure wave, and is a shock from strength 7. */
export function gasExplosionPulse(emitter, air) {
  const sourcePa = gasSourcePa(emitter);
  const strength = strengthOfPa(sourcePa);
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
