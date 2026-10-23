import { BLAST, BOOSTER } from './constants.js';
import { BLAST_PULSE, kinneyGrahamOverpressureRatio } from './blast-pulse.js';
import { flashSources, lightningEmitterFlashes } from './lightning.js';
import { barrageRounds } from './barrage.js';
import { fireworksBlasts } from './fireworks.js';
import { secondaryShockFactors } from './explosives.js';
import { flightMembers } from './flight.js';
import { followerPlacement } from '../shared/domain/follower.js';
import { meteorBursts, showerMembers } from './meteor.js';
import { fireballSpanSeconds } from './fireball.js';
import { friedlanderSpanSeconds } from '../shared/domain/pulses.js';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from '../shared/domain/air.js';
import { stormFlashes, stormFlashSequence } from './storm.js';
import { volcanoSources } from './volcano.js';
import { sourceTable, sourceTableBuilder } from '../shared/domain/source-table.js';
import { onGround } from '../shared/domain/terrain.js';


function flightSource(flight, flash = 0, pulse = 'n-wave') {
  return {
    flash, positionMetres: flight.startMetres, direction: null, elementMetres: 0, emissionSeconds: flight.startSeconds,
    amplitudePaMetres: 1, pulse, durationSeconds: .1, decay: 0, spanSeconds: 0, linearRadiusMetres: 0, turbulentFront: true
  };
}

const FIREBALL_OFF_DECIBELS = -60;

/** Class B, Sachs scaling; temperature neglected. */
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

/** Class B: Kinney & Graham amplitude and reference duration, Hopkinson–Cranz duration scaling. */
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

function meteorSources(emitter, air) {
  const members = showerMembers(emitter);
  return [...members.map(flightSource), ...members.flatMap((meteor, index) => meteorBursts(meteor, air).map(burst => highBlastSource(burst, air, index)))];
}

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
  if (emitter.kind === 'volcano') return { flashes: [], sources: volcanoSources(emitter, air, surface) };
  if (emitter.kind === 'meteor' || emitter.kind === 'shower') return { flashes: [], sources: meteorSources(emitter, air) };
  if (emitter.paths) return { flashes: [], sources: emitter.paths.map(saved => flightSource({ ...emitter, ...followerPlacement(saved) })) };
  if (emitter.kind === 'flight' || emitter.kind === 'formation') return { flashes: [], sources: flightMembers(emitter).map(flightSource) };
  if (emitter.kind === 'whip') return { flashes: [], sources: [flightSource(emitter)] };
  if (emitter.kind === 'booster') return { flashes: [], sources: [{ ...flightSource(emitter, 0, 'triple'), positionMetres: emitter.padMetres, middleShare: BOOSTER.middleShare, middleRatio: BOOSTER.middleRatio }] };
  if (emitter.kind === 'barrage') return { flashes: [], sources: barrageRounds(emitter).flatMap(round => blastSources(round, air, surface)) };
  if (emitter.kind === 'fireworks') return { flashes: [], sources: fireworksSources(emitter, air, surface) };
  const flashes = emitterFlashes(emitter, surface);
  return { flashes, sources: flashSources(flashes, flashPhysics(emitter, quality), air) };
}

const flashPhysics = (emitter, quality) => (quality?.sourceMerge > 1 ? { ...emitter, sourceMerge: quality.sourceMerge } : emitter);

/** A storm's flashes go in one at a time: all at once would take several times the table's memory. */
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
