import { BLAST } from './constants.js';
import { flashSources, lightningEmitterFlashes } from './lightning.js';
import { barrageRounds } from './barrage.js';
import { fireworksBlasts } from './fireworks.js';
import { secondaryShockFactors } from './explosives.js';
import { flightMembers } from './flight.js';
import { meteorBursts, showerMembers } from './meteor.js';
import { fireballSpanSeconds } from './fireball.js';
import { friedlanderSpanSeconds } from './pulses.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from './air.js';
import { stormFlashes, stormFlashSequence } from './storm.js';
import { sourceTable, sourceTableBuilder } from './source-table.js';
import { onGround } from './terrain.js';

export const EMITTER_KINDS = Object.freeze(['lightning', 'storm', 'blast', 'barrage', 'flight', 'formation', 'meteor', 'shower', 'whip', 'booster', 'fireworks']);

/** Class B: Kinney & Graham (1985) peak overpressure fit, ΔP/P = f(Z) with Z in m/kg^(1/3). */
const KINNEY_GRAHAM = Object.freeze({ scale: 808, numerator: 4.5, denominators: [.048, .32, 1.35] });

export function kinneyGrahamOverpressureRatio(scaledDistance) {
  const { scale, numerator, denominators } = KINNEY_GRAHAM;
  const top = scale * (1 + (scaledDistance / numerator) ** 2);
  return top / denominators.reduce((product, value) => product * Math.sqrt(1 + (scaledDistance / value) ** 2), 1);
}

/** A flight, whip, booster, or meteor as one row whose booms the renderer finds per receiver; `flash` is its index in a formation or shower. */
function flightSource(flight, flash = 0, pulse = 'n-wave') {
  return {
    flash, positionMetres: flight.startMetres, direction: null, elementMetres: 0, emissionSeconds: flight.startSeconds,
    amplitudePaMetres: 1, pulse, durationSeconds: .1, decay: 0, spanSeconds: 0, linearRadiusMetres: 0, flight: true
  };
}

/** The Fireball level at which a blast has no roar. */
const FIREBALL_OFF_DECIBELS = -60;

/**
 * A TNT blast's shock pulse: the scaled distance from where it propagates linearly, m/kg^⅓, its
 * positive phase per cube root of the charge, s/kg^⅓, and its Friedlander decay (see `blastSources`).
 */
export const BLAST_PULSE = Object.freeze({ linearScaledDistance: 20, durationSecondsPerCubeRootKilogram: .006, decay: 1 });

/**
 * A blast high in thin air as the shock of a ground-level one (class B, Sachs scaling): at pressure p
 * and sound speed c a charge W behaves as W·p₀/p does at the ground in size, with pressures scaled by
 * p/p₀ and times by c₀/c. Its amplitude is stated in ground-level air, √(p₀/p) higher, as a ray tube
 * carries it down (temperature neglected, as for a meteor's boom). No secondary shock or roar.
 */
function highBlastSource({ positionMetres, emissionSeconds, chargeKilograms }, air, flash) {
  const groundPressurePa = air.pressureKpa * 1000;
  const pressurePa = pressureAtHeightPa(air, positionMetres.z);
  const scale = groundPressurePa / pressurePa;
  const [shock] = blastSources({
    positionMetres, startSeconds: emissionSeconds, chargeKilograms: chargeKilograms * scale, explosive: 'tnt', secondaryShock: false,
    fireballDecibels: FIREBALL_OFF_DECIBELS, fireballSecondsPerSixthRootKilogram: 0, ...BLAST_PULSE
  }, { ...air, pressureKpa: pressurePa / 1000 });
  const durationSeconds = Math.min(BLAST.maximumHighBlastSeconds, shock.durationSeconds * Math.sqrt(temperatureAtHeightKelvin(air, 0) / temperatureAtHeightKelvin(air, positionMetres.z)));
  return { ...shock, flash, amplitudePaMetres: shock.amplitudePaMetres * Math.sqrt(scale), durationSeconds, spanSeconds: friedlanderSpanSeconds(durationSeconds, BLAST_PULSE.decay) };
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
  const secondary = { ...shock(BLAST.secondaryMassShare * emitter.chargeKilograms), secondaryShock: secondaryShockFactors(emitter.explosive, emitter.chargeKilograms) };
  // A large fireball burns as its buoyancy lifts it, in a time that grows as the sixth root of its mass
  const roarSeconds = emitter.fireballSecondsPerSixthRootKilogram * emitter.chargeKilograms ** (1 / 6);
  const roar = {
    flash: 0, positionMetres, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds,
    amplitudePaMetres: 10 ** (emitter.fireballDecibels / 20) * primary.amplitudePaMetres,
    pulse: 'noise', noiseSeed: emitter.seed, durationSeconds: roarSeconds, decay: 0,
    spanSeconds: fireballSpanSeconds(roarSeconds), linearRadiusMetres: 0
  };
  return [primary, ...(emitter.secondaryShock ? [secondary] : []), ...(emitter.fireballDecibels > FIREBALL_OFF_DECIBELS ? [roar] : [])];
}

export function emitterFlashes(emitter, surface = null) {
  if (emitter.kind === 'lightning') return lightningEmitterFlashes(emitter, surface);
  if (emitter.kind === 'storm') return stormFlashes(emitter, surface);
  return [];
}

/** A meteor's or shower's rows: one per meteor for its booms, first, then the blasts where each breaks up and bursts. */
function meteorSources(emitter, air) {
  const members = showerMembers(emitter);
  return [...members.map(flightSource), ...members.flatMap((meteor, index) => meteorBursts(meteor, air).map(burst => highBlastSource(burst, air, index)))];
}

/** A fireworks display's thump, burst, or pop (`fireworks.js`) as a TNT blast without a secondary shock or roar; a thump keeps its own positive phase. */
const fireworksBlast = blast => ({
  durationSecondsPerCubeRootKilogram: BLAST_PULSE.durationSecondsPerCubeRootKilogram, ...blast, kind: 'blast', explosive: 'tnt', secondaryShock: false,
  fireballDecibels: FIREBALL_OFF_DECIBELS, fireballSecondsPerSixthRootKilogram: 0, linearScaledDistance: BLAST_PULSE.linearScaledDistance, decay: BLAST_PULSE.decay
});

export const fireworksRounds = (emitter, air) => fireworksBlasts(emitter, air).events.map(fireworksBlast);

function fireworksSources(emitter, air, surface) {
  const { events, pops } = fireworksBlasts(emitter, air);
  return [...events, ...pops].flatMap(blast => blastSources(fireworksBlast(blast), air, surface));
}

export function emitterSources(emitter, air, surface = null, quality = null) {
  if (emitter.kind === 'blast') return { flashes: [], sources: blastSources(emitter, air, surface) };
  if (emitter.kind === 'meteor' || emitter.kind === 'shower') return { flashes: [], sources: meteorSources(emitter, air) };
  if (emitter.kind === 'flight' || emitter.kind === 'formation') return { flashes: [], sources: flightMembers(emitter).map(flightSource) };
  if (emitter.kind === 'whip') return { flashes: [], sources: [flightSource(emitter)] };
  if (emitter.kind === 'booster') return { flashes: [], sources: [{ ...flightSource(emitter, 0, 'triple'), positionMetres: emitter.padMetres }] };
  if (emitter.kind === 'barrage') return { flashes: [], sources: barrageRounds(emitter).flatMap(round => blastSources(round, air, surface)) };
  if (emitter.kind === 'fireworks') return { flashes: [], sources: fireworksSources(emitter, air, surface) };
  const flashes = emitterFlashes(emitter, surface);
  return { flashes, sources: flashSources(flashes, flashPhysics(emitter, quality), air) };
}

/** The render's quality may let one source stand in for several segments of a flash. */
const flashPhysics = (emitter, quality) => (quality?.sourceMerge > 1 ? { ...emitter, sourceMerge: quality.sourceMerge } : emitter);

/**
 * An emitter's point sources as a table, with its source rows when it has few. A storm's flashes
 * go into the table one at a time: all of a large storm's flashes and source objects at once would
 * take several times the memory of the table.
 */
export function emitterSourceTable(emitter, air, surface = null, quality = null) {
  if (emitter.kind !== 'storm') {
    const rows = emitterSources(emitter, air, surface, quality).sources;
    return { sources: sourceTable(rows), rows };
  }
  const builder = sourceTableBuilder();
  const physics = flashPhysics(emitter, quality);
  let index = 0;
  for (const flash of stormFlashSequence(emitter, surface)) flashSources([flash], physics, air, builder, index++);
  return { sources: builder.table(), rows: [] };
}
