import { BLAST_PULSE } from './blast-pulse.js';
import { ROOM_EXPLOSION } from './constants.js';
import { deflagrationPulse, onsetAmplitude, pulseSource, roarSamples, roarSpanSeconds } from './gas-explosion.js';
import { onGround } from '../shared/domain/terrain.js';

export const MATERIAL_TYPES = Object.freeze(Object.keys(ROOM_EXPLOSION.materials));
export const VENT_TYPES = Object.freeze(Object.keys(ROOM_EXPLOSION.vents));
export const INTERIOR_TYPES = Object.freeze(Object.keys(ROOM_EXPLOSION.interiors));
export const ROOM_IGNITION_TYPES = Object.freeze(Object.keys(ROOM_EXPLOSION.ignitions));

const BAR_PA = 1e5;
const OFF_DECIBELS = -60;
const STANDARD_AIR = Object.freeze({ pressureKpa: 101.325, temperatureCelsius: 15 });

export const roomSideMetres = cubicMetres => Math.cbrt(cubicMetres);

export const roomRadiusMetres = cubicMetres => Math.cbrt(3 * cubicMetres / (2 * Math.PI));

/** Class B: NFPA 68 eq. 7.2.6.1a–f, the burning velocity's turbulent enhancement for an enclosure and its vent. */
export function turbulenceFactor({ hydraulicMetres, ventMetres, burningMetresPerSecond, pressureBar }) {
  const { densityKilogramsPerCubicMetre: density, viscosityPascalSeconds: viscosity, soundMetresPerSecond, flameReynolds, flameExponent, ventFactor, ventMetresPerSecond } = ROOM_EXPLOSION;
  const flame = density * burningMetresPerSecond * hydraulicMetres / 2 / viscosity;
  const enclosure = flame < flameReynolds ? 1 : (flame / flameReynolds) ** flameExponent;
  const speed = Math.min(Math.sqrt(2 * BAR_PA * pressureBar / density), soundMetresPerSecond);
  const vent = density * speed * ventMetres / 2 / viscosity;
  return enclosure * Math.max(1, ventFactor * (vent / 1e6) ** Math.sqrt(ventMetresPerSecond / burningMetresPerSecond));
}

/** Class B: NFPA 68 eq. 7.2.1a with C = 0.0223 λ S_u, solved for P_red with λ at P_red. */
export function gasVentedBar({ surfaceSquareMetres, ventSquareMetres, hydraulicMetres, burningMetresPerSecond }) {
  const ventMetres = Math.sqrt(4 * ventSquareMetres / Math.PI);
  let pressureBar = .1;
  let factor = 1;
  for (let step = 0; step < 60; step += 1) {
    factor = turbulenceFactor({ hydraulicMetres, ventMetres, burningMetresPerSecond, pressureBar });
    const next = (surfaceSquareMetres * ROOM_EXPLOSION.gasCoefficient * factor * burningMetresPerSecond / ventSquareMetres) ** 2;
    if (Math.abs(next - pressureBar) < 1e-9 * next) { pressureBar = next; break; }
    pressureBar = (pressureBar + next) / 2;
  }
  return { pressureBar, factor };
}

/** Class B: NFPA 68 eq. 8.2.1.1 solved for P_red. */
export function dustVentedBar({ cubicMetres, ventSquareMetres, kSt, maximumBar, staticBar }) {
  const reference = ROOM_EXPLOSION.dustCoefficient * (1 + ROOM_EXPLOSION.dustStatic * staticBar ** (4 / 3)) * kSt * cubicMetres ** .75;
  return maximumBar / (1 + (ventSquareMetres / reference) ** 2);
}

/** Class A: a Helmholtz resonator, the neck's sound speed class C after Cooper et al. 1986 Fig. 1. */
export function ringHz(cubicMetres, ventSquareMetres, wallMetres = ROOM_EXPLOSION.wallMetres) {
  const neckMetres = wallMetres + 1.7 * Math.sqrt(ventSquareMetres / Math.PI);
  return ROOM_EXPLOSION.ringSoundShare * ROOM_EXPLOSION.soundMetresPerSecond / (2 * Math.PI) * Math.sqrt(ventSquareMetres / (cubicMetres * neckMetres));
}

export function roomPressures(emitter) {
  const material = ROOM_EXPLOSION.materials[emitter.material];
  const vent = ROOM_EXPLOSION.vents[emitter.ventStrength];
  const side = roomSideMetres(emitter.roomCubicMetres);
  const surfaceSquareMetres = 6 * side * side;
  const ventSquareMetres = Math.min(emitter.ventSquareMetres, side * side);
  const vented = gasVentedBar({ surfaceSquareMetres, ventSquareMetres, hydraulicMetres: side, burningMetresPerSecond: material.burningMetresPerSecond });
  const factor = material.mixingLimited ? 1 : vented.factor;
  const gasBar = material.mixingLimited ? (surfaceSquareMetres * ROOM_EXPLOSION.gasCoefficient * material.burningMetresPerSecond / ventSquareMetres) ** 2 : vented.pressureBar;
  const ventPa = vent.kilopascals * 1000;
  const designBar = material.kSt ? dustVentedBar({ cubicMetres: emitter.roomCubicMetres, ventSquareMetres, kSt: material.kSt, maximumBar: material.maximumBar, staticBar: ventPa / BAR_PA }) : gasBar;
  const empty = emitter.interior === 'empty' && !material.mixingLimited;
  const share = empty ? ROOM_EXPLOSION.emptyTurbulenceShare : 1;
  const far = emitter.ignition === 'far';
  const developedPa = Math.min(material.maximumBar * BAR_PA, designBar * BAR_PA * share ** 2 * (far ? ROOM_EXPLOSION.farIgnitionPressureFactor : 1));
  const structurePa = emitter.structureKilopascals * 1000;
  const wallsFail = Math.max(ventPa, developedPa) > structurePa;
  const openPa = Math.min(ventPa, structurePa);
  const insidePa = wallsFail ? structurePa : Math.max(ventPa, developedPa);
  const flameMetresPerSecond = ROOM_EXPLOSION.expansionRatio * factor * share * material.burningMetresPerSecond;
  const burnSeconds = (far ? side : side / 2) / flameMetresPerSecond;
  return {
    side, surfaceSquareMetres, ventSquareMetres, openingSquareMetres: wallsFail ? Math.max(ventSquareMetres, side * side) : ventSquareMetres,
    breakingSquareMetres: ventPa <= structurePa ? ventSquareMetres : side * side,
    openPa, insidePa, wallsFail, flameMetresPerSecond, burnSeconds,
    openSeconds: burnSeconds * Math.min(1, Math.cbrt(openPa / (material.maximumBar * BAR_PA))),
    openingSeconds: ventPa <= structurePa ? vent.openSeconds : ROOM_EXPLOSION.wallOpenSeconds
  };
}

export const roomCombustionJoules = emitter => ROOM_EXPLOSION.materials[emitter.material].megajoulesPerCubicMetre * 1e6 * emitter.roomCubicMetres;

export const roomEquivalentKilograms = emitter => roomCombustionJoules(emitter) / 4.68e6;

const ejectedShare = emitter => (emitter.ignition === 'far' ? 1 : Math.PI / 6) * (1 - 1 / ROOM_EXPLOSION.expansionRatio);

/** Class A: the stored compression V·P/(γP₀) leaves through the opening at the Bernoulli rate; a monopole p·r = ρ/(4π)·dQ/dt over the opening time (class C). */
export function breakPulse(emitter, pressures, air) {
  const { densityKilogramsPerCubicMetre: density, dischargeCoefficient, heatCapacityRatio } = ROOM_EXPLOSION;
  const storedCubicMetres = emitter.roomCubicMetres * pressures.openPa / (heatCapacityRatio * air.pressureKpa * 1000);
  const flow = dischargeCoefficient * pressures.breakingSquareMetres * Math.sqrt(2 * pressures.openPa / density);
  const effective = Math.min(flow, 2 * storedCubicMetres / pressures.openingSeconds);
  const peakPaMetres = density * effective / (4 * Math.PI * pressures.openingSeconds);
  const onsetSeconds = pressures.openingSeconds;
  const durationSeconds = Math.max(2 * onsetSeconds, storedCubicMetres / Math.max(effective, 1e-12));
  return { peakPaMetres, onsetSeconds, durationSeconds, decay: BLAST_PULSE.decay, amplitudePaMetres: onsetAmplitude(peakPaMetres, onsetSeconds, durationSeconds, BLAST_PULSE.decay) };
}

/** Class A: the room is compact, so its volume production radiates as the free flame's 2ρ(1 − 1/σ)S² at the edge of a cloud of its volume, halved because the ground doubles it. */
export function burnPulse(emitter, pressures) {
  const { densityKilogramsPerCubicMetre: density, expansionRatio } = ROOM_EXPLOSION;
  const sourcePa = 2 * density * (1 - 1 / expansionRatio) * pressures.flameMetresPerSecond ** 2;
  const peakPaMetres = sourcePa * roomRadiusMetres(emitter.roomCubicMetres) / 2;
  const onsetSeconds = pressures.burnSeconds;
  const durationSeconds = pressures.burnSeconds;
  return { sourcePa, peakPaMetres, onsetSeconds, durationSeconds, decay: BLAST_PULSE.decay, amplitudePaMetres: onsetAmplitude(peakPaMetres, onsetSeconds, durationSeconds, BLAST_PULSE.decay) };
}

/** Class C: the mixture pushed out ahead of the flame, diluted, burns as a free cloud at half the room's pressure (Harrison & Eyre 1987). */
export function externalPulse(emitter, pressures, air) {
  const cubicMetres = ROOM_EXPLOSION.externalDilution * ejectedShare(emitter) * emitter.roomCubicMetres;
  return deflagrationPulse({
    sourcePa: ROOM_EXPLOSION.externalPressureShare * pressures.insidePa,
    radiusMetres: roomRadiusMetres(cubicMetres),
    kilograms: ejectedShare(emitter) * roomEquivalentKilograms(emitter)
  }, air);
}

export const roomRoarTailSeconds = emitter => emitter.fireballSecondsPerSixthRootKilogram * roomEquivalentKilograms(emitter) ** (1 / 6);

/** Class C: the burned gas swings in the opening at the Helmholtz frequency; p̂ a share of the room's pressure, far field ρω²V·p̂/(4πγP₀). */
export function roomRing(emitter, pressures, air = STANDARD_AIR) {
  const hz = ringHz(emitter.roomCubicMetres, pressures.openingSquareMetres);
  const omega = 2 * Math.PI * hz;
  const amplitudePa = ROOM_EXPLOSION.ringPressureShare * pressures.insidePa;
  const paMetres = ROOM_EXPLOSION.densityKilogramsPerCubicMetre * omega ** 2 * emitter.roomCubicMetres * amplitudePa / (4 * Math.PI * ROOM_EXPLOSION.heatCapacityRatio * air.pressureKpa * 1000);
  return { hz, paMetres: emitter.ringDecibels > OFF_DECIBELS ? paMetres * 10 ** (emitter.ringDecibels / 20) : 0, seconds: ROOM_EXPLOSION.ringCycles / hz };
}

export function roomExplosion(emitter, air) {
  const pressures = roomPressures(emitter);
  const breaking = breakPulse(emitter, pressures, air);
  const burning = burnPulse(emitter, pressures);
  const external = externalPulse(emitter, pressures, air);
  const ring = roomRing(emitter, pressures, air);
  const roarPaMetres = emitter.fireballDecibels > OFF_DECIBELS ? 10 ** (emitter.fireballDecibels / 20) * Math.max(external.peakPaMetres, burning.peakPaMetres) : 0;
  const peakPaMetres = Math.max(breaking.peakPaMetres, burning.peakPaMetres, external.peakPaMetres);
  return { pressures, breaking, burning, external, ring, roarPaMetres, peakPaMetres, kilograms: roomEquivalentKilograms(emitter) };
}

function noiseLayout(emitter, explosion) {
  const burnSeconds = explosion.pressures.burnSeconds + explosion.external.burnSeconds;
  const tailSeconds = roomRoarTailSeconds(emitter);
  const ringStart = explosion.pressures.burnSeconds;
  const spanSeconds = Math.max(roarSpanSeconds(burnSeconds, tailSeconds), ringStart + 3 * explosion.ring.seconds);
  return { burnSeconds, tailSeconds, ringStart, spanSeconds, levelPaMetres: Math.max(explosion.roarPaMetres, explosion.ring.paMetres) };
}

/** Class C: the roar of the burn inside and out, with the Helmholtz ring from when the flame reaches the opening. */
export function roomNoiseSamples(seed, durationSeconds, sampleRate, emitter) {
  const explosion = roomExplosion(emitter, STANDARD_AIR);
  const layout = noiseLayout(emitter, explosion);
  const length = Math.ceil(layout.spanSeconds * sampleRate);
  const samples = new Float64Array(length);
  if (layout.levelPaMetres <= 0) return samples;
  if (explosion.roarPaMetres > 0) {
    const roar = roarSamples(seed, { burnSeconds: layout.burnSeconds, tailSeconds: layout.tailSeconds, strength: explosion.external.strength, radiusMetres: roomRadiusMetres(emitter.roomCubicMetres) }, sampleRate);
    const gain = explosion.roarPaMetres / layout.levelPaMetres;
    for (let index = 0; index < Math.min(length, roar.length); index += 1) samples[index] = gain * roar[index];
  }
  const { hz, paMetres, seconds } = explosion.ring;
  if (paMetres > 0) {
    const gain = paMetres / layout.levelPaMetres;
    const damping = -Math.log(ROOM_EXPLOSION.ringFloor) / seconds;
    for (let index = Math.ceil(layout.ringStart * sampleRate); index < length; index += 1) {
      const t = index / sampleRate - layout.ringStart;
      samples[index] += gain * Math.sin(2 * Math.PI * hz * t) * Math.exp(-damping * t);
    }
  }
  return samples;
}

export function roomExplosionSources(emitter, air, surface = null) {
  const positionMetres = surface ? onGround(surface, emitter.positionMetres) : emitter.positionMetres;
  const explosion = roomExplosion(emitter, air);
  const common = seconds => ({ flash: 0, positionMetres, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds + seconds });
  const { pressures, breaking, burning, external } = explosion;
  const sources = [pulseSource(common(0), burning, air), pulseSource(common(pressures.burnSeconds), external, air)];
  if (breaking.peakPaMetres > 0) sources.unshift(pulseSource(common(pressures.openSeconds), breaking, air));
  const layout = noiseLayout(emitter, explosion);
  if (layout.levelPaMetres > 0) {
    sources.push({
      ...common(0), amplitudePaMetres: layout.levelPaMetres, pulse: 'noise', noiseSeed: emitter.seed,
      durationSeconds: layout.spanSeconds, decay: 0, spanSeconds: layout.spanSeconds, linearRadiusMetres: 0
    });
  }
  return sources;
}
