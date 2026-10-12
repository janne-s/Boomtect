import { airAtHeight, atmosphericAbsorptionNepersPerMetre, pressureAtHeightPa, temperatureAtHeightKelvin } from './air.js';
import { ambisonicDirection, channelCount, encodeDirection } from './ambisonics.js';
import { BOOSTER, FLIGHT, GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, GROUND, KELVIN_OFFSET, MODEL_VERSION, PROPAGATION, RENDER, VIEW } from './constants.js';
import { emitterSources } from './emitters.js';
import { knifeEdge } from './diffraction.js';
import { diffuseTails, foliageExponent, foliageMetres, forestResponses, forestSeed, surroundingsResponses } from './forest.js';
import { PULSE_FRIEDLANDER, PULSE_NOISE, PULSE_NWAVE, PULSE_TRIPLE, sourcePosition, sourceTable } from './source-table.js';
import { secondaryShockDelay } from './explosives.js';
import { fireballSamples } from './fireball.js';
import { boosterPath, flightBooms, flightMembers, flightPath, whipBody, whipPath, withApproach } from './flight.js';
import { meteorBooms, meteorTrack, showerMembers } from './meteor.js';
import { onGround, terrainSurface } from './terrain.js';
import { arrivalSector, echoField, echoPaths, sourceCells } from './terrain-echoes.js';
import { meanPlaneFrame, shieldingEdges, terrainMultipleReflections, terrainReflection } from './terrain-propagation.js';
import { convolveAdd, fft, nextPowerOfTwo } from './fft.js';
import { creepingTransitionHz, cubeRootExponent, softExponent } from './creeping.js';
import { isReflecting, planeReflectionMagnitude, sphericalReflectionCoefficient } from './ground.js';
import { weakShockPulse } from './lightning.js';
import { riseSmoothing, tripleTerm } from './pulses.js';
import { createRandom, normalDeviate } from './random.js';
import {
  creepingCoefficient, inShadow, pathProfile, PATH_DIRECT, PATH_ECHO, PATH_GROUND, PATH_SCATTER, PATH_SHADOW, rayBetween, reflectedRay, shadowPath, soundSpeedProfile, speedAt
} from './refraction.js';

/** Samples kept before each arrival for zero-phase smoothing, absorption, and directivity. */
const PRE_ROLL_SAMPLES = 512;
/** Terrain edges kept per path (Deygout's main edge and one on each side). */
const MAXIMUM_EDGES = 3;
/** Samples kept after each pulse for the ground-reflection response to settle. */
const TAIL_GUARD_SAMPLES = 2048;
/** Attenuation beyond which a bin no longer contributes: 14 Np ≈ 122 dB. */
const NEGLIGIBLE_NEPERS = 14;
const NEGLIGIBLE_SMOOTHING = 1e-7;
const GROUND_GRID_POINTS = 64;
/**
 * In layered air, absorption is tabulated at heights this far apart and at this many frequencies
 * spaced evenly in log frequency, and each path takes the mean over the heights it spans. Linear
 * interpolation between the frequencies is within 0.1 dB of the coefficient up to 3 Np of loss.
 */
const ABSORPTION_LAYER_METRES = 250;
const ABSORPTION_GRID_POINTS = 128;
/** Gaussian kernel standard deviation per 10–90 % rise time, as in `pulses.js`. */
const RISE_TIME_PER_SIGMA = 2.5631;
/** Coefficient of nonlinearity of air, (γ + 1)/2 (class A). */
const AIR_NONLINEARITY = (GAMMA_AIR + 1) / 2;
/** Refraction radii at which a frame group tabulates its ground's creeping mode when the wind varies them. */
const CREEPING_RADII = 8;
/** The scattered share of a reflection on the ground grid, per path. */
const groundScatter = new Float64Array(GROUND_GRID_POINTS);
const SMALL_ARGUMENT = 1e-4;

/**
 * Seconds until the shadow response for a creeping loss of `nepersAtOneHertz` has fallen 80 dB below
 * its peak: an upper bound measured on its impulse response for creeping distances of 0.2–60 km and
 * gradients of 2–12 K/km, t ≤ 0.1 + 0.6·β^0.65.
 */
export function shadowTailSeconds(nepersAtOneHertz) {
  if (!(nepersAtOneHertz > 0)) return 0;
  return .1 + .6 * creepingBeta(nepersAtOneHertz) ** .65;
}

/**
 * Paths are framed per emitter, separately for shadow paths, whose response needs a longer tail, and
 * for echoes, whose sources are the emitter's cells. A blast's roar lasts seconds, which would make
 * its frames as long: its paths are framed as impulses in groups of their own, and their sum is
 * convolved once with the roar, separately for its ground reflections, which carry a roar of their
 * own seed (see accumulatePath).
 */
const FRAME_GROUPS = 5;
const ROAR_GROUP = 3;
/** Share of a render's progress given to tracing its paths. */
const TRACE_SHARE = .3;
const isEcho = kind => kind === PATH_ECHO || kind === PATH_SCATTER;
const frameGroup = (paths, index) => FRAME_GROUPS * paths.emitter[index]
  + (paths.roar[index] ? ROAR_GROUP + paths.roar[index] - 1 : isEcho(paths.kind[index]) ? 2 : paths.creepNepers[index] > 0 ? 1 : 0);
/** The point sources a path starts from: the emitter's sources, or its cells for an echo. */
/** The table a path's source row is in: its emitter's echo cells at this receiver for an echo, otherwise its sources. */
const pathSources = (preparedEmitters, paths, index) => (isEcho(paths.kind[index]) ? paths.cells[paths.emitter[index]] : preparedEmitters[paths.emitter[index]].sources);

/** Whether a scene traces terrain echoes. */
export const echoesActive = scene => Boolean(scene.terrain?.enabled && scene.terrain.echoes);

/**
 * Expands every enabled emitter into point sources, kept as a typed table so that the flash
 * geometry behind them can be released, and pools them into cells when terrain echoes are traced.
 * Pure and deterministic from the scene.
 */
export function prepareScene(scene) {
  const surface = terrainSurface(scene.terrain);
  const echoes = echoesActive(scene) && !surface.flat;
  const prepared = scene.emitters.filter(emitter => emitter.enabled).map(emitter => {
    const rows = emitterSources(emitter, scene.air, surface).sources;
    const sources = sourceTable(rows);
    // The booms of a flight or a meteor leave its path where each receiver's arrival is stationary.
    // Their echoes come from each receiver's booms (`receiverPaths`) and from a meteor's breakups and burst.
    if (emitter.kind === 'booster') return { emitter, sources, cells: null, echoRows: [], flights: [{ flight: emitter, path: boosterPath(emitter, scene.air, surface), booms: flightBooms, pulse: 'triple' }] };
    if (emitter.kind === 'whip') return { emitter, sources, cells: null, echoRows: [], flights: [{ flight: whipBody(emitter), path: whipPath(emitter, scene.air, surface), booms: flightBooms }] };
    if (emitter.kind === 'flight' || emitter.kind === 'formation') {
      return { emitter, sources, cells: null, echoRows: [], flights: flightMembers(emitter).map(flight => ({ flight, path: withApproach(flightPath(flight, scene.air), scene.air), booms: flightBooms })) };
    }
    if (emitter.kind === 'meteor' || emitter.kind === 'shower') {
      const flights = showerMembers(emitter).map(meteor => ({ flight: meteor, path: meteorTrack(meteor), booms: meteorBooms }));
      return { emitter, sources, cells: null, echoRows: rows.slice(flights.length), flights };
    }
    return { emitter, sources, cells: echoes ? sourceCells(sources, scene.terrain.echoCellMetres) : null };
  });
  const count = prepared.reduce((sum, item) => sum + item.sources.length, 0);
  if (count > RENDER.maximumSources) throw new RangeError(`The scene has ${count} point sources; the limit is ${RENDER.maximumSources}.`);
  return prepared;
}

/**
 * The top of the layer of air a path's profile describes (class C): the ground layer for a path that
 * stays within it, otherwise the tropopause. A ray rising above it meets air of another gradient.
 */
function airCeiling(air, top) {
  if (air.groundLayerMetres > 0 && top <= air.groundLayerMetres) return air.groundLayerMetres;
  return air.tropopauseMetres > 0 ? air.tropopauseMetres : Infinity;
}

/**
 * Class A: a receiver above the ground hears a pulse defined in ground-level air scaled by
 * sqrt(ρc at the receiver / ρc at the ground), from the energy flux along a ray tube. Source levels
 * are stated for ground-level air, so this is 1 at the ground and in homogeneous air.
 */
function receiverImpedanceFactor(air, profile, heightMetres) {
  if (!air.refraction) return 1;
  const density = pressureAtHeightPa(air, heightMetres) / pressureAtHeightPa(air, 0) * temperatureAtHeightKelvin(air, 0) / temperatureAtHeightKelvin(air, heightMetres);
  return Math.sqrt(density * speedAt(profile, heightMetres) / profile.groundSpeed);
}

/** Entries per path of the arrays wider than one. */
const PATH_WIDTHS = Object.freeze({ direction: 3, edges: MAXIMUM_EDGES, endLift: 2, endSine: 2 });

/** The arrays of a path table, by name, with their element types. */
const PATH_ARRAYS = Object.freeze({
  emitter: Uint16Array,
  source: Uint32Array,
  kind: Uint8Array,
  seconds: Float64Array,
  metres: Float64Array,
  spreadMetres: Float64Array,
  /** Creeping loss of a shadow path at 1 Hz, αL in nepers, which grows as f^(1/3). */
  creepNepers: Float64Array,
  /** Radius c₀/|g| of the air along a shadow path, which scales its ground's creeping mode. */
  creepRadius: Float64Array,
  directivityCos: Float64Array,
  cosIncidence: Float64Array,
  duration: Float64Array,
  amplitudeScale: Float64Array,
  direction: Float64Array,
  edgeCount: Uint8Array,
  edges: Float64Array,
  /** Ground contacts of a reflected path: 1, or more where the air bends rays back down. */
  bounces: Uint8Array,
  /** An echo's image path differences at its source and receiver ends, metres, and the sines of its legs there. */
  endLift: Float64Array,
  endSine: Float64Array,
  /** The echo's source height above its ground, which reflects as rigid ground within the source's linearization radius. */
  sourceHeight: Float64Array,
  /** Length of the path under a forest's canopy, metres. */
  foliageMetres: Float64Array,
  /** 1 for a path of a blast's roar, 2 for its ground reflection, 0 for any other. */
  roar: Uint8Array,
  /** The time a scattered echo spreads over, seconds, from just before its arrival. */
  timeSpread: Float64Array,
  /** Height of the point the path leaves from: its source's, or where a boom leaves its flight path. */
  height: Float64Array
});

/** An empty path table with room for `capacity` paths. */
function pathTable(capacity) {
  const paths = { count: 0 };
  for (const [key, Type] of Object.entries(PATH_ARRAYS)) paths[key] = new Type(Math.max(1, capacity) * (PATH_WIDTHS[key] ?? 1));
  return paths;
}

/**
 * What tracing at a receiver needs, the same in every part of it: the air, the ground, each body's
 * booms there, and each emitter's echo cells. Over terrain each boom also echoes, as a point source
 * where it leaves the path whose pressure at the receiver's distance is the boom's (class C: the
 * cone's front taken as a sphere from there, which holds near the receiver).
 */
function tracingFrame(preparedEmitters, receiver, scene) {
  const profile = soundSpeedProfile(scene.air);
  const surface = terrainSurface(scene.terrain);
  const receiverPosition = onGround(surface, receiver.positionMetres);
  const booms = preparedEmitters.map(prepared => prepared.flights?.map(({ flight, path, booms: find }) => find(path, flight, receiverPosition, profile, scene.air)) ?? null);
  const traceEchoes = echoesActive(scene) && !surface.flat;
  const cells = preparedEmitters.map((prepared, emitterIndex) => {
    if (!prepared.flights) return prepared.cells;
    if (!traceEchoes) return null;
    const rows = [...prepared.echoRows, ...booms[emitterIndex].flatMap((list, member) => list.map(boom => boomEchoRow(boom, member, prepared.flights[member].pulse)))];
    return rows.length ? sourceCells(sourceTable(rows), scene.terrain.echoCellMetres) : null;
  });
  return { profile, surface, receiverPosition, booms, cells, ground: scene.ground.enabled };
}

/** Writes paths into a table, growing it as needed: `add(emitterIndex, sourceIndex, sources, kind, path, edges)`. */
function pathWriter(frame, scene, paths) {
  const { profile, surface, receiverPosition } = frame;
  const impedance = receiverImpedanceFactor(scene.air, profile, receiverPosition.z);
  const shockImpedance = airShockImpedance(scene.air);
  const treeHeight = scene.ground.forest ? scene.ground.treeHeightMetres : 0;
  const receiverLift = receiverPosition.z - surface.heightAt(receiverPosition.x, receiverPosition.y);
  let room = paths.seconds.length;
  const grow = () => {
    room = Math.max(16, 2 * room);
    for (const [key, array] of Object.entries(paths)) {
      if (!ArrayBuffer.isView(array)) continue;
      const larger = new array.constructor(room * (PATH_WIDTHS[key] ?? 1));
      larger.set(array);
      paths[key] = larger;
    }
  };
  return (emitterIndex, sourceIndex, sources, kind, path, edges = []) => {
    const index = paths.count;
    if (index >= room) grow();
    const { departure, arrival } = path;
    paths.bounces[index] = path.bounces ?? (kind === PATH_GROUND ? 1 : 0);
    paths.edgeCount[index] = edges.length;
    edges.forEach((edge, edgeIndex) => { paths.edges[MAXIMUM_EDGES * index + edgeIndex] = edge; });
    paths.emitter[index] = emitterIndex;
    paths.source[index] = sourceIndex;
    paths.kind[index] = kind;
    paths.roar[index] = sources.pulse[sourceIndex] === PULSE_NOISE ? (kind === PATH_GROUND ? 2 : 1) : 0;
    paths.metres[index] = path.metres;
    paths.spreadMetres[index] = path.spreadMetres / impedance;
    paths.creepNepers[index] = path.creepNepers ?? 0;
    paths.creepRadius[index] = path.creepRadius ?? 0;
    paths.seconds[index] = (path.emissionSeconds ?? sources.emissionSeconds[sourceIndex]) + path.seconds
      + (sources.secondaryDelaySeconds[sourceIndex] > 0 ? secondaryShockDelay(sources.secondaryDelaySeconds[sourceIndex], sources.secondaryCubeRoot[sourceIndex], path.metres) : 0);
    // The element's phase spread uses the local wavelength, so its directivity cosine carries c₀/c.
    paths.directivityCos[index] = sources.directed[sourceIndex]
      ? (sources.dx[sourceIndex] * departure.x + sources.dy[sourceIndex] * departure.y + sources.dz[sourceIndex] * departure.z) * profile.groundSpeed / speedAt(profile, sources.z[sourceIndex])
      : 0;
    paths.cosIncidence[index] = path.groundSine ?? 1;
    paths.endLift[2 * index] = path.sourceLift ?? 0;
    paths.endLift[2 * index + 1] = path.receiverLift ?? 0;
    paths.endSine[2 * index] = path.sourceSine ?? 0;
    paths.endSine[2 * index + 1] = path.receiverSine ?? 0;
    paths.sourceHeight[index] = path.sourceHeight ?? 0;
    paths.timeSpread[index] = path.timeSpread ?? 0;
    const from = path.from ?? sourcePosition(sources, sourceIndex);
    paths.height[index] = from.z;
    paths.foliageMetres[index] = !treeHeight ? 0 : isEcho(kind) ? path.foliageMetres
      : foliageMetres(path.metres, from.z - surface.heightAt(from.x, from.y), receiverLift, treeHeight);
    paths.direction.set(path.metres > 0 ? ambisonicDirection(-arrival.x, -arrival.y, -arrival.z) : [1, 0, 0], 3 * index);
    if (path.durationSeconds !== undefined) {
      // A boom brings its own duration and pressure; the row's amplitude is 1 Pa·m.
      paths.duration[index] = path.durationSeconds;
      paths.amplitudeScale[index] = path.overpressurePa * path.spreadMetres;
    } else if (sources.relaxationRadius[sourceIndex] > 0) {
      const pulse = weakShockPulse(sources.relaxationRadius[sourceIndex], sources.sourcePeriodSeconds[sourceIndex], path.metres, sources.limitRadii[sourceIndex]);
      paths.duration[index] = pulse.durationSeconds;
      paths.amplitudeScale[index] = pulse.amplitudeScale;
    } else if (sources.pulse[sourceIndex] === PULSE_FRIEDLANDER) {
      const lift = sources.z[sourceIndex] - surface.heightAt(sources.x[sourceIndex], sources.y[sourceIndex]);
      const stretch = blastStretch(sources, sourceIndex, path.metres, shockImpedance, lift);
      paths.duration[index] = sources.durationSeconds[sourceIndex] * stretch;
      paths.amplitudeScale[index] = 1 / stretch;
    } else {
      paths.duration[index] = sources.durationSeconds[sourceIndex];
      paths.amplitudeScale[index] = 1;
    }
    paths.count += 1;
  };
}

/** The `part`-th of `parts` contiguous ranges of `count` items: [start, end). */
const partRange = (count, part, parts) => [Math.floor(count * part / parts), Math.floor(count * (part + 1) / parts)];

/**
 * One part of the tracing at a receiver, for one of several threads: the sources and the echo
 * places in its contiguous share of each. Returns its direct, shadow, and ground paths in one
 * table; each emitter's specular echoes in a table of their own; and each emitter's scattered
 * echoes as sums by arrival bin and direction (`mergeScattered`), in the order their bins first
 * occurred, which `assemblePaths` adds across parts. The tables are cut to their count.
 */
export function tracePart(preparedEmitters, receiver, scene, { part = 0, parts = 1, onProgress = null } = {}) {
  const frame = tracingFrame(preparedEmitters, receiver, scene);
  const { profile, surface, receiverPosition, booms, cells, ground } = frame;
  const sourceCount = preparedEmitters.reduce((sum, item) => sum + item.sources.length, 0);
  const placeCount = cells.reduce((sum, table) => sum + (table ? table.places.length : 0), 0);
  const [sourceStart, sourceEnd] = partRange(sourceCount, part, parts);
  const [placeStart, placeEnd] = partRange(placeCount, part, parts);
  // Progress over this part's echo places and then its sources, reported about every percent.
  const units = sourceEnd - sourceStart + placeEnd - placeStart;
  const every = Math.max(1, Math.floor(units / 100));
  let done = 0;
  const tick = onProgress ? () => { done += 1; if (done % every === 0) onProgress(done / units); } : () => {};

  // Echoes first, as the progress counts them.
  const specular = cells.map(() => null);
  const scattered = cells.map(() => null);
  if (placeEnd > placeStart) {
    const field = echoField(surface, profile, receiverPosition, {
      scattering: scene.terrain.scattering, limit: scene.terrain.echoLimit, shadowFloor: 10 ** (-scene.air.shadowFloorDecibels / 20)
    });
    const treeHeight = scene.ground.forest ? scene.ground.treeHeightMetres : 0;
    const receiverHeight = Math.max(0, receiverPosition.z - surface.heightAt(receiverPosition.x, receiverPosition.y));
    let offset = 0;
    cells.forEach((table, emitterIndex) => {
      if (!table) return;
      const { places } = table;
      const from = Math.max(0, placeStart - offset);
      const to = Math.min(places.length, placeEnd - offset);
      offset += places.length;
      if (to <= from) return;
      const cellsOf = Array.from({ length: places.length }, () => []);
      for (let cell = 0; cell < table.length; cell += 1) cellsOf[table.place[cell]].push(cell);
      const paths = pathTable(16);
      const add = pathWriter(frame, scene, paths);
      const merged = new Map();
      // Place by place, so that only one place's traced paths are held at a time.
      for (let place = from; place < to; place += 1) {
        tick();
        const point = { x: places.x[place], y: places.y[place], z: places.z[place] };
        const traced = echoPaths(field, point);
        const sourceHeight = Math.max(0, point.z - surface.heightAt(point.x, point.y));
        for (const path of traced) Object.assign(path, endImages(path, sourceHeight, receiverHeight, treeHeight));
        for (const cell of cellsOf[place]) {
          for (const path of traced) {
            if (path.kind === PATH_SCATTER) mergeScattered(merged, table, cell, path);
            else add(emitterIndex, cell, table, path.kind, path);
          }
        }
      }
      specular[emitterIndex] = compactPaths(paths).paths;
      scattered[emitterIndex] = [...merged];
    });
  }

  const direct = pathTable((sourceEnd - sourceStart) * (ground ? 2 : 1));
  const add = pathWriter(frame, scene, direct);
  let offset = 0;
  preparedEmitters.forEach((prepared, emitterIndex) => {
    const { sources } = prepared;
    const from = Math.max(0, sourceStart - offset);
    const to = Math.min(sources.length, sourceEnd - offset);
    offset += sources.length;
    const flightCount = prepared.flights?.length ?? 0;
    for (let sourceIndex = from; sourceIndex < to; sourceIndex += 1) {
      tick();
      if (sourceIndex < flightCount) {
        for (const boom of booms[emitterIndex][sourceIndex]) {
          const shared = { emissionSeconds: boom.emissionSeconds, from: boom.point, durationSeconds: boom.durationSeconds };
          // Beyond the carpet's edge the boom creeps into the shadow along the ground, as a point source's sound does, without a reflection of its own.
          if (boom.shadow) {
            add(emitterIndex, sourceIndex, sources, PATH_SHADOW, {
              ...boom.ray, ...shared, overpressurePa: boom.overpressurePa * boom.focus,
              creepNepers: creepingCoefficient(boom.along) * boom.ray.creepMetres, creepRadius: boom.along.groundSpeed / -boom.along.gradient
            });
            continue;
          }
          add(emitterIndex, sourceIndex, sources, PATH_DIRECT, { ...boom.ray, ...shared, overpressurePa: boom.overpressurePa * boom.focus });
          if (!ground) continue;
          // Its ground reflection carries the boom's pressure over its own length (Carlson's r^(−¾)); the ground model reflects it (K_R).
          const reflected = surface.flat ? reflectedRay(boom.along, boom.point, receiverPosition) : terrainReflection(boom.along, surface, boom.point, receiverPosition);
          if (reflected) add(emitterIndex, sourceIndex, sources, PATH_GROUND, { ...reflected, ...shared, overpressurePa: boom.overpressurePa * boom.focus * (boom.ray.metres / reflected.metres) ** .75 });
        }
        continue;
      }
      tracePoint(frame, scene, add, emitterIndex, sourceIndex, sources);
    }
  });
  return { direct: compactPaths(direct).paths, specular, scattered };
}

/** The direct or shadow path from one point source and its ground reflections. */
function tracePoint(frame, scene, add, emitterIndex, sourceIndex, sources) {
  const { profile, surface, receiverPosition, ground } = frame;
  const position = sourcePosition(sources, sourceIndex);
  // In wind, the air along this path has its own effective profile.
  const along = pathProfile(profile, position, receiverPosition);
  // Only air whose speed falls with height casts a shadow; over terrain it is judged from the mean ground plane.
  if (along.gradient < 0) {
    const plane = surface.flat ? { profile: along, from: position, to: receiverPosition } : meanPlaneFrame(along, surface.heightAt, position, receiverPosition);
    if (inShadow(plane.profile, plane.from, plane.to)) {
      const shadow = shadowPath(plane.profile, plane.from, plane.to);
      add(emitterIndex, sourceIndex, sources, PATH_SHADOW, { ...shadow, creepNepers: creepingCoefficient(along) * shadow.creepMetres, creepRadius: along.groundSpeed / -along.gradient });
      return;
    }
  }
  const shielding = !surface.flat && scene.terrain.shielding;
  const edges = shielding ? shieldingEdges(along, surface, position, receiverPosition) : [];
  add(emitterIndex, sourceIndex, sources, PATH_DIRECT, rayBetween(along, position, receiverPosition), edges);
  if (!ground) return;
  // The reflection near the receiver crosses the same ridges as the direct sound (class C).
  const reflected = surface.flat ? reflectedRay(along, position, receiverPosition) : terrainReflection(along, surface, position, receiverPosition);
  if (reflected) add(emitterIndex, sourceIndex, sources, PATH_GROUND, reflected, edges);
  // Where the air bends rays back down they may touch the ground several times (class C over terrain),
  // but not those whose highest point leaves the layer the path's profile describes.
  if (along.gradient > 0) {
    const ceiling = airCeiling(scene.air, Math.max(position.z, receiverPosition.z));
    for (const ray of terrainMultipleReflections(along, surface, position, receiverPosition)) {
      const apex = along.groundSpeed / along.gradient * (1 / Math.sqrt(1 - ray.groundSine ** 2) - 1);
      if (apex <= ceiling) add(emitterIndex, sourceIndex, sources, PATH_GROUND, ray, edges);
    }
  }
}

/** Appends a table's paths to another with room for them. */
function appendPaths(target, source) {
  if (!source?.count) return;
  for (const key of Object.keys(PATH_ARRAYS)) {
    const width = PATH_WIDTHS[key] ?? 1;
    target[key].set(source[key].subarray(0, source.count * width), target.count * width);
  }
  target.count += source.count;
}

/**
 * Every path at a receiver from the parts of its tracing, in the order one thread traces them:
 * every emitter's sources in order, direct before ground; then each emitter's specular echoes by
 * place and cell, and its scattered echoes merged across all its cells. The scattered sums add up
 * in another order than in one thread, so they agree to rounding; which member is the strongest
 * does not depend on it.
 */
export function assemblePaths(preparedEmitters, receiver, scene, parts) {
  const frame = tracingFrame(preparedEmitters, receiver, scene);
  const merged = frame.cells.map((_, emitterIndex) => {
    const sums = new Map();
    for (const part of parts) {
      for (const [key, entry] of part.scattered[emitterIndex] ?? []) {
        const sum = sums.get(key);
        if (!sum) { sums.set(key, { ...entry }); continue; }
        for (const field of MERGED_SUM_KEYS) sum[field] += entry[field];
        if (entry.strongest > sum.strongest) Object.assign(sum, { strongest: entry.strongest, cell: entry.cell, seconds: entry.seconds });
      }
    }
    return sums;
  });
  const count = parts.reduce((sum, part) => sum + part.direct.count + part.specular.reduce((total, table) => total + (table?.count ?? 0), 0), 0)
    + merged.reduce((sum, sums) => sum + sums.size, 0);
  const paths = pathTable(count);
  for (const part of parts) appendPaths(paths, part.direct);
  const add = pathWriter(frame, scene, paths);
  frame.cells.forEach((table, emitterIndex) => {
    for (const part of parts) appendPaths(paths, part.specular[emitterIndex]);
    for (const sum of merged[emitterIndex].values()) add(emitterIndex, sum.cell, table, PATH_SCATTER, mergedPath(sum, table));
  });
  paths.cells = frame.cells;
  return paths;
}

/**
 * Every path from the prepared sources to one receiver, as parallel typed arrays: the direct ray,
 * or in the refraction shadow the creeping path, and the ground-reflected ray where one exists.
 * Order is emitter, source, then direct before ground, so it is deterministic. `metres` is the
 * length along the path, which absorption and the weak shock use; `spreadMetres` the distance
 * whose inverse is the geometric amplitude; `edges` the geometric factors of the terrain edges
 * that shield a direct path (see `diffraction.js`).
 *
 * Over terrain, the refraction shadow and the ground reflection are found from the ground under the
 * receiver, as if the ground there extended level; the shielding checks the actual terrain.
 */
export function receiverPaths(preparedEmitters, receiver, scene, { onProgress = null } = {}) {
  return assemblePaths(preparedEmitters, receiver, scene, [tracePart(preparedEmitters, receiver, scene, { onProgress })]);
}

/**
 * Traced paths cut to their count, for sending to another thread, with the buffers that can be
 * transferred rather than copied.
 */
export function compactPaths(paths) {
  const compact = { count: paths.count, cells: paths.cells };
  for (const [key, array] of Object.entries(paths)) {
    if (ArrayBuffer.isView(array)) compact[key] = array.slice(0, paths.count * (PATH_WIDTHS[key] ?? 1));
  }
  return { paths: compact, buffers: Object.values(compact).filter(ArrayBuffer.isView).map(array => array.buffer) };
}

/** ρc³ of the ground-level air, which sets how fast a shock ages. */
export function airShockImpedance(air) {
  const density = air.pressureKpa * 1000 / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * (air.temperatureCelsius + KELVIN_OFFSET));
  return density * soundSpeedProfile(air).groundSpeed ** 3;
}

/**
 * How much a blast's positive phase has lengthened, and its peak fallen, after `metres` of path.
 * A blast's shock ages as it spreads (class B, weak-shock theory of a spherical wave; Whitham 1956,
 * Pierce, Acoustics, ch. 11): its front outruns the zero crossing by βp/(2ρc³) per metre while p·T·r
 * stays fixed, so from the linearization radius r₀ on its positive phase lengthens as
 * T = T₀·√(1 + σ·ln(r/r₀)), σ = β·p₀·r₀/(ρc³T₀), and its peak falls by the same factor. The growth
 * stops where the pulse is no longer a shock, T/τ = PROPAGATION.oldAgeDurationRatio, at
 * r = T₀p₀r₀/(2K). A blast within its linearization radius of the ground spreads as a merged
 * hemispherical front of PROPAGATION.mergedFrontFactor times the pressure.
 */
export function blastStretch(sources, index, metres, shockImpedance, heightMetres) {
  const r0 = sources.linearRadiusMetres[index];
  const T0 = sources.durationSeconds[index];
  if (!(metres > r0 && r0 > 0 && T0 > 0)) return 1;
  const p0 = sources.amplitudePaMetres[index] / r0 * (heightMetres < r0 ? PROPAGATION.mergedFrontFactor : 1);
  const oldAge = T0 * p0 * r0 / (PROPAGATION.oldAgeDurationRatio * PROPAGATION.shockRisePascalSeconds);
  const sigma = AIR_NONLINEARITY * p0 * r0 / (shockImpedance * T0);
  return Math.sqrt(1 + sigma * Math.log(Math.min(metres, oldAge) / r0));
}

/** A boom as the source row of its echoes: its pulse (an N-wave unless given) from where it leaves the path, at its pressure along its ray. */
function boomEchoRow(boom, member, pulse = 'n-wave') {
  return {
    flash: member, positionMetres: boom.point, direction: null, elementMetres: 0, emissionSeconds: boom.emissionSeconds,
    amplitudePaMetres: boom.overpressurePa * boom.focus * boom.ray.metres, pulse,
    durationSeconds: boom.durationSeconds, decay: 0, spanSeconds: boom.durationSeconds, linearRadiusMetres: 0, flight: true
  };
}

/**
 * The image path differences and leg sines at an echo's two ends, over the ground taken level there
 * (class C), and the length of its two legs under the forest's canopy. An echo leaves a source near
 * the ground and reaches a receiver near it together with its image in the ground there: each end
 * adds the ground's reflection delayed by 2·h·sin φ, the image's extra path (class B, the same
 * reflection as the direct sound's), up to PROPAGATION.endImageSeconds.
 */
function endImages(path, sourceHeight, receiverHeight, treeHeight) {
  const sourceSine = Math.abs(path.departure.z);
  const receiverSine = Math.abs(path.arrival.z);
  const [down, up] = path.legMetres;
  const foliage = treeHeight ? foliageMetres(down, sourceHeight, 0, treeHeight) + foliageMetres(up, 0, receiverHeight, treeHeight) : 0;
  return { sourceHeight, sourceSine, receiverSine, sourceLift: 2 * sourceHeight * sourceSine, receiverLift: 2 * receiverHeight * receiverSine, foliageMetres: foliage };
}

/**
 * Scattered echoes from all of an emitter's cells that reach the receiver within one
 * PROPAGATION.scatterBinSeconds and from one direction sector merge into one path (class C): its energy is
 * their sum, its direction, length, and incidence their energy-weighted means, and its arrival and
 * pulse those of the strongest. Scattering is incoherent, so this keeps the tail's energy and
 * density while the number of paths stays bounded by time and direction rather than by cells.
 * A mean arrival would settle near the middle of each bin and space the paths evenly, which sounds
 * as a tone at 1/PROPAGATION.scatterBinSeconds (measured: 100 Hz, 40 dB above the tail's spectrum).
 */
function mergeScattered(merged, cells, cell, path) {
  const arrival = cells.emissionSeconds[cell] + path.seconds;
  const key = Math.floor(arrival / PROPAGATION.scatterBinSeconds) * 64 + arrivalSector(path.arrival);
  const energy = (cells.amplitudePaMetres[cell] / path.spreadMetres) ** 2;
  let entry = merged.get(key);
  if (!entry) {
    entry = { energy: 0, seconds: 0, metres: 0, cosine: 0, x: 0, y: 0, z: 0, sourceLift: 0, receiverLift: 0, sourceSine: 0, receiverSine: 0, sourceHeight: 0, foliageMetres: 0, spreadSeconds: 0, cell, strongest: 0 };
    merged.set(key, entry);
  }
  entry.energy += energy;
  entry.metres += energy * path.metres;
  entry.cosine += energy * path.groundSine;
  entry.x += energy * path.arrival.x;
  entry.y += energy * path.arrival.y;
  entry.z += energy * path.arrival.z;
  for (const key of MERGED_END_KEYS) entry[key] += energy * path[key];
  if (energy > entry.strongest) Object.assign(entry, { strongest: energy, cell, seconds: path.seconds });
}

const MERGED_END_KEYS = Object.freeze(['sourceLift', 'receiverLift', 'sourceSine', 'receiverSine', 'sourceHeight', 'foliageMetres', 'spreadSeconds']);
/** The fields of merged scattered echoes that add up across cells. */
const MERGED_SUM_KEYS = Object.freeze(['energy', 'metres', 'cosine', 'x', 'y', 'z', ...MERGED_END_KEYS]);

function mergedPath(entry, cells) {
  const { energy, cell } = entry;
  const length = Math.hypot(entry.x, entry.y, entry.z);
  const arrival = { x: entry.x / length, y: entry.y / length, z: entry.z / length };
  return {
    seconds: entry.seconds,
    metres: entry.metres / energy,
    spreadMetres: cells.amplitudePaMetres[cell] / Math.sqrt(energy),
    departure: arrival,
    arrival,
    groundSine: entry.cosine / energy,
    ...Object.fromEntries(MERGED_END_KEYS.map(key => [key, entry[key] / energy])),
    // Its patches arrive across the bin as well as across their own widths.
    timeSpread: entry.spreadSeconds / energy + PROPAGATION.scatterBinSeconds
  };
}

/** The level change of a path's terrain edges at one frequency, in decibels. */
function edgeDecibels(paths, index, frequencyHz) {
  let decibels = 0;
  for (let edge = 0; edge < paths.edgeCount[index]; edge += 1) {
    decibels += 20 * Math.log10(Math.hypot(...knifeEdge(paths.edges[MAXIMUM_EDGES * index + edge] * Math.sqrt(frequencyHz))));
  }
  return decibels;
}

/**
 * Arrival time, source height, and geometric level of every path, for the arrival diagram; a
 * shadow path's level includes its creeping loss at VIEW.arrivalDiagramHz.
 */
export function arrivalTable(preparedEmitters, receiver, scene, options = {}) {
  const paths = options.paths ?? receiverPaths(preparedEmitters, receiver, scene, options);
  const heights = new Float32Array(paths.count);
  const levels = new Float32Array(paths.count);
  const bearings = new Float32Array(paths.count);
  const floor = 10 ** (-scene.air.shadowFloorDecibels / 20);
  const soft = scene.ground.enabled && !isReflecting(scene.ground.type);
  const speed = soundSpeedProfile(scene.air).groundSpeed;
  const transitions = new Map();
  /** The ground's creeping transition frequency per refraction radius, or 0 on rigid ground. */
  const diagramCreep = radius => {
    if (!soft) return 0;
    const key = radius.toPrecision(4);
    if (!transitions.has(key)) transitions.set(key, creepingTransitionHz(GROUND.flowResistivity[scene.ground.type], speed, radius));
    return transitions.get(key);
  };
  for (let index = 0; index < paths.count; index += 1) {
    const sources = pathSources(preparedEmitters, paths, index);
    heights[index] = paths.height[index];
    // The compass direction the sound comes from, from its Ambisonic direction (north, west, up).
    bearings[index] = ((Math.atan2(-paths.direction[3 * index + 1], paths.direction[3 * index]) * 180 / Math.PI) + 360) % 360;
    levels[index] = 20 * Math.log10(sources.amplitudePaMetres[paths.source[index]] * paths.amplitudeScale[index] / Math.max(paths.spreadMetres[index], 1e-3))
      + (paths.creepNepers[index] > 0 ? 20 * Math.log10(Math.hypot(...shadowResponse(VIEW.arrivalDiagramHz, paths.creepNepers[index], floor, diagramCreep(paths.creepRadius[index])))) : 0)
      + edgeDecibels(paths, index, VIEW.arrivalDiagramHz);
  }
  return { count: paths.count, seconds: paths.seconds.slice(0, paths.count), heights, levels, bearings, kinds: paths.kind.slice(0, paths.count) };
}

/**
 * Class B (Clifford & Lataitis 1983, as summarized by Salomons 2001; verify): turbulence with
 * mean-square refractive-index fluctuation ⟨μ²⟩ and scale L gives a phase variance
 * σ² = A·√π·⟨μ²⟩·k²·R·L, with A = 0.5 when R > kL² and 1 otherwise. The direct and reflected rays,
 * separated by about h = 2·hs·hr/(hs + hr), share part of it: ρ = (√π/2)(L/h)·erf(h/L). Their phase
 * difference therefore varies with variance 2σ²(1 − ρ).
 */
export function turbulentPhaseVariance(frequencyHz, metres, sourceHeight, receiverHeight, air, speed) {
  if (!(air.turbulenceStrength > 0)) return 0;
  const k = 2 * Math.PI * frequencyHz / speed;
  const scale = air.turbulenceScaleMetres;
  const factor = metres > k * scale * scale ? .5 : 1;
  const variance = factor * Math.sqrt(Math.PI) * air.turbulenceStrength * k * k * metres * scale;
  const separation = sourceHeight + receiverHeight > 0 ? 2 * sourceHeight * receiverHeight / (sourceHeight + receiverHeight) : 0;
  const shared = separation > 0 ? Math.sqrt(Math.PI) / 2 * (scale / separation) * erf(separation / scale) : 1;
  return 2 * variance * Math.max(0, 1 - shared);
}

/** Abramowitz & Stegun 7.1.26, |error| < 1.5e-7. */
function erf(x) {
  const t = 1 / (1 + .3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/**
 * Frame layout of one frame group at one receiver: hop H and block 2H hold any of its paths with
 * pre-roll and tail. It depends on all of the group's paths, so every time range shares it.
 */
function framePlan(prepared, group, paths, sampleRate, profile, scene, receiverZ) {
  const speed = profile.groundSpeed;
  let highest = receiverZ;
  let longestElement = 0;
  let longestSpan = 0;
  let largestCreep = 0;
  let smallestRadius = Infinity;
  let largestRadius = 0;
  for (const table of [prepared.sources, paths.cells[Math.floor(group / FRAME_GROUPS)]].filter(Boolean)) {
    for (let index = 0; index < table.length; index += 1) longestElement = Math.max(longestElement, table.elementMetres[index]);
  }
  for (let index = 0; index < paths.count; index += 1) {
    if (frameGroup(paths, index) !== group) continue;
    const sources = isEcho(paths.kind[index]) ? paths.cells[paths.emitter[index]] : prepared.sources;
    const source = paths.source[index];
    // A weak shock's span is its period; an aged blast's tail lengthens with its positive phase; the
    // roar is framed as an impulse.
    const span = paths.roar[index] ? 0 : sources.relaxationRadius[source] > 0 ? paths.duration[index]
      : sources.pulse[source] === PULSE_FRIEDLANDER ? sources.spanSeconds[source] * paths.duration[index] / sources.durationSeconds[source]
        : Math.max(sources.spanSeconds[source], sources.flight[source] ? paths.duration[index] : 0);
    // A boom's turbulent front reaches FLIGHT.turbulentFront.longestRises rise times past it, a reflection's scattered part as many of its means.
    longestSpan = Math.max(longestSpan, span + paths.timeSpread[index] + FLIGHT.turbulentFront.longestRises * ((sources.flight[source] ? prepared.emitter.riseTimeSeconds : 0) + GROUND.scatterSeconds));
    largestCreep = Math.max(largestCreep, paths.creepNepers[index]);
    if (paths.creepRadius[index] > 0) {
      smallestRadius = Math.min(smallestRadius, paths.creepRadius[index]);
      largestRadius = Math.max(largestRadius, paths.creepRadius[index]);
    }
    highest = Math.max(highest, paths.height[index]);
  }
  const preRoll = PRE_ROLL_SAMPLES + Math.ceil(longestElement / speed * sampleRate / 2);
  // Soft ground lags the creeping response up to PROPAGATION.softCreepLag times as much as rigid ground, which spreads it.
  const soft = scene.ground.enabled && !isReflecting(scene.ground.type);
  const shadowTail = Math.ceil(shadowTailSeconds(largestCreep * (soft ? PROPAGATION.softCreepLag : 1)) * sampleRate);
  const hop = nextPowerOfTwo(preRoll + Math.ceil(longestSpan * sampleRate) + TAIL_GUARD_SAMPLES + shadowTail);
  const size = 2 * hop;
  const bins = hop + 1;
  const absorption = new Float64Array(bins);
  const smoothing = new Float64Array(bins);
  const gridPosition = new Float64Array(bins);
  const lowest = sampleRate / size;
  const ratio = Math.log((sampleRate / 2) / lowest);
  let smoothingLimit = bins;
  for (let bin = 0; bin < bins; bin += 1) {
    const frequency = bin * sampleRate / size;
    absorption[bin] = scene.air.absorption ? atmosphericAbsorptionNepersPerMetre(frequency, scene.air) : 0;
    // A boom's rise comes mostly from its turbulent front (`turbulentFront`); each part of it rises in a tenth.
    smoothing[bin] = riseSmoothing(frequency, prepared.emitter.riseTimeSeconds / (prepared.flights ? FLIGHT.turbulentFront.riseRatio : 1));
    if (smoothingLimit === bins && smoothing[bin] < NEGLIGIBLE_SMOOTHING) smoothingLimit = bin;
    gridPosition[bin] = bin === 0 ? 0 : Math.min(GROUND_GRID_POINTS - 1.000001, Math.log(frequency / lowest) / ratio * (GROUND_GRID_POINTS - 1));
  }
  const foliage = scene.ground.forest ? { loss: new Float64Array(bins), lag: new Float64Array(bins) } : null;
  if (foliage) for (let bin = 1; bin < bins; bin += 1) [foliage.loss[bin], foliage.lag[bin]] = foliageExponent(bin * sampleRate / size);
  const groundFrequencies = Float64Array.from({ length: GROUND_GRID_POINTS }, (_, index) => lowest * Math.exp(ratio * index / (GROUND_GRID_POINTS - 1)));
  const layered = scene.air.absorption && scene.air.refraction ? layeredAbsorption(scene.air, lowest, sampleRate / 2, bins, sampleRate / size, highest) : null;
  const shadowFloor = 10 ** (-scene.air.shadowFloorDecibels / 20);
  const shadow = largestCreep > 0 ? { loss: new Float64Array(bins), lag: new Float64Array(bins) } : null;
  if (shadow) {
    for (let bin = 1; bin < bins; bin += 1) [shadow.loss[bin], shadow.lag[bin]] = shadowExponent(bin * sampleRate / size);
    if (soft) shadow.ground = groundCreeping(scene.ground.type, speed, smallestRadius, largestRadius);
  }
  return { preRoll, hop, size, bins, absorption, layered, foliage, shadow, shadowFloor, smoothing, smoothingLimit, gridPosition, groundFrequencies, binHz: sampleRate / size, riseSeconds: prepared.emitter.riseTimeSeconds };
}

/**
 * Absorption in layered air (class B per layer, ISO 9613-1 with `airAtHeight`): the coefficient at
 * every ABSORPTION_LAYER_METRES up to `highest` on a log-frequency grid, and its integral over height
 * from the datum, so that a path's mean over the heights it spans is a difference of two integrals.
 * `position[bin]` places each FFT bin on the frequency grid.
 */
function layeredAbsorption(air, lowest, highestFrequency, bins, binHz, highest) {
  const layers = Math.max(2, Math.ceil(Math.max(0, highest) / ABSORPTION_LAYER_METRES) + 2);
  const ratio = Math.log(highestFrequency / lowest);
  const frequencies = Float64Array.from({ length: ABSORPTION_GRID_POINTS }, (_, index) => lowest * Math.exp(ratio * index / (ABSORPTION_GRID_POINTS - 1)));
  const coefficient = new Float64Array(layers * ABSORPTION_GRID_POINTS);
  const integral = new Float64Array(layers * ABSORPTION_GRID_POINTS);
  for (let layer = 0; layer < layers; layer += 1) {
    const atmosphere = airAtHeight(air, layer * ABSORPTION_LAYER_METRES);
    for (let point = 0; point < ABSORPTION_GRID_POINTS; point += 1) {
      const at = layer * ABSORPTION_GRID_POINTS + point;
      coefficient[at] = atmosphericAbsorptionNepersPerMetre(frequencies[point], atmosphere);
      integral[at] = layer ? integral[at - ABSORPTION_GRID_POINTS] + (coefficient[at] + coefficient[at - ABSORPTION_GRID_POINTS]) / 2 * ABSORPTION_LAYER_METRES : 0;
    }
  }
  const position = new Float64Array(bins);
  for (let bin = 1; bin < bins; bin += 1) position[bin] = Math.min(ABSORPTION_GRID_POINTS - 1.000001, Math.max(0, Math.log(bin * binHz / lowest) / ratio * (ABSORPTION_GRID_POINTS - 1)));
  return { layers, coefficient, integral, position, path: new Float64Array(ABSORPTION_GRID_POINTS) };
}

/** Fills `layered.path` with the mean absorption between two heights above the datum, in Np/m. */
function pathAbsorption(layered, fromZ, toZ) {
  const { layers, coefficient, integral, path } = layered;
  const top = (layers - 1) * ABSORPTION_LAYER_METRES;
  const low = Math.min(top, Math.max(0, Math.min(fromZ, toZ)));
  const high = Math.min(top, Math.max(0, Math.max(fromZ, toZ)));
  const place = z => {
    const layer = Math.min(layers - 2, Math.floor(z / ABSORPTION_LAYER_METRES));
    return [layer * ABSORPTION_GRID_POINTS, z / ABSORPTION_LAYER_METRES - layer];
  };
  const [lowAt, lowMix] = place(low);
  if (high - low < 1) {
    for (let point = 0; point < ABSORPTION_GRID_POINTS; point += 1) {
      path[point] = coefficient[lowAt + point] + (coefficient[lowAt + ABSORPTION_GRID_POINTS + point] - coefficient[lowAt + point]) * lowMix;
    }
    return path;
  }
  const [highAt, highMix] = place(high);
  for (let point = 0; point < ABSORPTION_GRID_POINTS; point += 1) {
    const lowIntegral = integral[lowAt + point] + (integral[lowAt + ABSORPTION_GRID_POINTS + point] - integral[lowAt + point]) * lowMix;
    const highIntegral = integral[highAt + point] + (integral[highAt + ABSORPTION_GRID_POINTS + point] - integral[highAt + point]) * highMix;
    path[point] = (highIntegral - lowIntegral) / (high - low);
  }
  return path;
}

/** A path's absorption coefficient at a bin: the plan's ground air, or the path's mean in layered air. */
function binAbsorption(plan, bin) {
  if (!plan.layered) return plan.absorption[bin];
  const { position, path } = plan.layered;
  const at = position[bin];
  const lower = Math.floor(at);
  return path[lower] + (path[lower + 1] - path[lower]) * (at - lower);
}

/**
 * The transition frequency of the scene's ground's creeping mode (`creeping.js`) for refraction
 * radii spaced evenly in log between the smallest and largest of a frame group's shadow paths,
 * which differ only in wind; a path interpolates between them.
 */
function groundCreeping(groundType, speed, smallest, largest) {
  const rows = largest > smallest * 1.0001 ? CREEPING_RADII : 1;
  const radii = Float64Array.from({ length: rows }, (_, row) => (rows > 1 ? smallest * (largest / smallest) ** (row / (rows - 1)) : smallest));
  const transitions = Float64Array.from(radii, radius => creepingTransitionHz(GROUND.flowResistivity[groundType], speed, radius));
  return { radii, transitions };
}

/** The transition frequency for one path's refraction radius, interpolated in log. */
function pathTransitionHz(ground, radius) {
  const { radii, transitions } = ground;
  if (radii.length === 1) return transitions[0];
  let row = 0;
  while (row < radii.length - 2 && radius > radii[row + 1]) row += 1;
  const mix = Math.min(1, Math.max(0, Math.log(radius / radii[row]) / Math.log(radii[row + 1] / radii[row])));
  return transitions[row] * (transitions[row + 1] / transitions[row]) ** mix;
}

/** Share of a grazing shock's reflection that is linear, from its parameter a; smooth between the regimes. */
function linearShare(parameter) {
  return smoothStep((parameter - PROPAGATION.mergedParameter) / (PROPAGATION.linearParameter - PROPAGATION.mergedParameter));
}

function smoothStep(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** The first bin whose absorption over `metres` is negligible; call after `pathAbsorption` in layered air. */
function absorptionLimit(plan, metres) {
  let low = 0;
  let high = plan.smoothingLimit;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (binAbsorption(plan, middle) * metres > NEGLIGIBLE_NEPERS) high = middle; else low = middle + 1;
  }
  return low;
}

/**
 * The shadow's transfer at one frequency, in the e^(+iωt) convention of `fft.js`. `nepersAtOneHertz`
 * is the creeping loss αL at 1 Hz, which grows as f^(1/3). The creeping mode's propagation constant
 * carries s^(1/3), s = iω, so its loss comes with a phase lag of 1/√3 of it: H = exp(−β·s^(1/3)) is
 * causal and delays the low frequencies (class B). Its impulse response has a t^(−4/3) tail, so
 * s^(1/3) becomes s·(s + ω_c)^(−2/3): a plain delay well below PROPAGATION.shadowRegularizationHz, a
 * loss 4.4 % short of the creeping law at 50 Hz, 2.1 % at 100 Hz, and 0.5 % at 400 Hz, and an
 * impulse response whose tail decays exponentially (class C).
 * The scattered share F of the shadow floor joins it smoothly, (1 − F)·H + F (class C).
 */
export function shadowResponse(frequencyHz, nepersAtOneHertz, floor, transitionHz = 0) {
  const [loss, lag] = shadowExponent(frequencyHz);
  if (!transitionHz) return shadowFromExponent(loss, lag, creepingBeta(nepersAtOneHertz), floor);
  const [softLoss, softLag] = softExponent(frequencyHz, transitionHz);
  return shadowFromExponent(loss + softLoss, lag + softLag, creepingBeta(nepersAtOneHertz), floor);
}

/** β of the creeping response from its loss at 1 Hz: α(1 Hz)·L = (√3/2)·β·(2π)^(1/3). */
const creepingBeta = nepersAtOneHertz => 2 * nepersAtOneHertz / (Math.sqrt(3) * Math.cbrt(2 * Math.PI));

/** Real and imaginary parts of s·(s + ω_c)^(−2/3) at s = iω, which depend on frequency alone. */
const shadowExponent = frequencyHz => cubeRootExponent(frequencyHz, PROPAGATION.shadowRegularizationHz);

function shadowFromExponent(loss, lag, beta, floor) {
  const magnitude = (1 - floor) * Math.exp(-beta * loss);
  const phase = -beta * lag;
  return [magnitude * Math.cos(phase) + floor, magnitude * Math.sin(phase)];
}

/**
 * Adds one path into a frame spectrum: source pulse × rise smoothing × geometric spreading ×
 * ISO 9613-1 absorption along the path × line-element directivity × ground reflection × the
 * shadow response × e^(−iωτ) for the exact fractional offset τ. Trigonometric terms advance by rotation from bin to bin.
 */
function accumulatePath(spectra, gains, plan, sources, sourceIndex, paths, index, offsetSamples, scene, speed, groundRe, groundIm, ends, seed, receiverHeight, receiverZ) {
  const channels = spectra.length;
  const metres = paths.metres[index];
  if (plan.layered) pathAbsorption(plan.layered, paths.height[index], receiverZ);
  const { absorption, layered, foliage, smoothing, gridPosition, binHz, size } = plan;
  // Foliage scatters the sound out of the path, causally; it is not undone by the shock's steepening (class C).
  // A sparser forest scatters in proportion to its density, as fewer trunks and leaves per metre (class C).
  const underCanopy = foliage ? Math.min(paths.foliageMetres[index], GROUND.maximumFoliageMetres) * scene.ground.forestDensity : 0;
  // The pulse's peak at the receiver, Pa, and its acoustic Mach number.
  const gain = sources.amplitudePaMetres[sourceIndex] * paths.amplitudeScale[index] / Math.max(paths.spreadMetres[index], Number.MIN_VALUE);
  if (!(gain > 0)) return;
  const mach = gain / (GAMMA_AIR * scene.air.pressureKpa * 1000);
  // Absorption beyond the steady shock's own smoothing is undone by steepening: the loss is capped at
  // that of a front rising in PROPAGATION.shockRisePascalSeconds / Δp, as far as the pulse is still a shock.
  const riseSeconds = PROPAGATION.shockRisePascalSeconds / gain;
  // A blast's roar is no shock.
  const pulseKind = sources.pulse[sourceIndex];
  const shock = pulseKind === PULSE_NOISE ? 0 : smoothStep((paths.duration[index] / riseSeconds - PROPAGATION.oldAgeDurationRatio) / (PROPAGATION.shockDurationRatio - PROPAGATION.oldAgeDurationRatio));
  const shockSigma = riseSeconds / RISE_TIME_PER_SIGMA;
  const pathLoss = (bin, linear) => (shock > 0 ? linear - shock * Math.max(0, linear - 2 * (Math.PI * shockSigma * bin * binHz) ** 2) : linear);
  const shockLimit = shock > 0 ? Math.ceil(Math.sqrt(NEGLIGIBLE_NEPERS / 2) / (Math.PI * shockSigma * binHz)) : 0;
  const limit = Math.min(plan.smoothingLimit, Math.max(absorptionLimit(plan, metres), shockLimit));
  if (limit < 2) return;
  const creepNepers = paths.creepNepers[index];
  const { shadow, shadowFloor } = plan;
  const beta = creepNepers > 0 ? creepingBeta(creepNepers) : 0;
  const transitionHz = creepNepers > 0 && shadow.ground ? pathTransitionHz(shadow.ground, paths.creepRadius[index]) : 0;
  const edgeCount = paths.edgeCount[index];
  const kind = paths.kind[index];
  const reflected = kind === PATH_GROUND;
  const ground = (reflected || isEcho(kind)) && !isReflecting(scene.ground.type);
  const turbulent = reflected && scene.air.turbulenceStrength > 0;
  // Share of the reflection that follows the ground's impedance; the rest merges with the direct front.
  const merging = reflected ? 1 - shock * (1 - linearShare(paths.cosIncidence[index] / Math.sqrt(2 * AIR_NONLINEARITY * mach))) : 1;
  let scattering = false;
  if (ground || turbulent) {
    const roughness = reflected && ground ? GROUND.roughnessMetres : 0;
    for (let point = 0; point < GROUND_GRID_POINTS; point += 1) {
      const frequency = plan.groundFrequencies[point];
      // A specular echo reflects like the ground; a scattered one keeps the reflected share of its energy.
      let q = !ground ? [1, 0]
        : kind === PATH_SCATTER ? [planeReflectionMagnitude(frequency, scene.ground.type, paths.cosIncidence[index]), 0]
          : sphericalReflectionCoefficient(frequency, scene.ground.type, paths.cosIncidence[index], metres, speed);
      // The coherent share, and the scattered rest; the part of a shock merging with the direct front stays whole.
      const k = 2 * Math.PI * frequency / speed;
      const variance = (2 * k * roughness * paths.cosIncidence[index]) ** 2
        + (turbulent ? turbulentPhaseVariance(frequency, metres, paths.height[index], receiverHeight, scene.air, speed) : 0);
      const coherent = reflected ? Math.exp(-variance / 2) : 1;
      groundScatter[point] = reflected ? merging * Math.hypot(q[0], q[1]) * Math.sqrt(1 - coherent * coherent) : 0;
      if (groundScatter[point] > 0) scattering = true;
      q = [merging * coherent * q[0] + 1 - merging, merging * coherent * q[1]];
      // Every contact of a ray that touches the ground several times reflects it at the same angle (class C).
      for (let bounce = 1, single = q; bounce < paths.bounces[index]; bounce += 1) q = [q[0] * single[0] - q[1] * single[1], q[0] * single[1] + q[1] * single[0]];
      groundRe[point] = q[0];
      groundIm[point] = q[1];
    }
  }
  const reflectionScatter = scattering ? subArrivals(GROUND.scatterArrivals, GROUND.scatterSeconds, seed ^ Math.imul(index + 1, 0x165667b1), binHz) : null;
  // An echo's ground images at its ends: the reflection coefficient on the grid, the delay rotated per bin.
  const endCount = isEcho(kind) ? echoEnds(ends, plan, scene, sources, sourceIndex, paths, index, metres, speed) : 0;
  const spreadArrivals = paths.timeSpread[index] > 0 ? scatterArrivals(paths.timeSpread[index], seed ^ Math.imul(index + 1, 0x85ebca6b), binHz) : null;
  // A boom's front, shared by its ground reflection, and its echoes, which return the front that reached the ground.
  const turbulence = sources.flight[sourceIndex] ? turbulentFront(plan.riseSeconds, FLIGHT.turbulentFront.frontShare * Math.sqrt(scene.air.turbulenceStrength / FLIGHT.turbulentFront.referenceTurbulence), isEcho(kind) ? seed ^ Math.imul(index + 1, 0x27d4eb2f) : seed, binHz) : null;
  const phaseStep = -2 * Math.PI * offsetSamples / size;
  const phaseStepRe = Math.cos(phaseStep);
  const phaseStepIm = Math.sin(phaseStep);
  let phaseRe = phaseStepRe;
  let phaseIm = phaseStepIm;

  const elementMetres = sources.elementMetres[sourceIndex];
  const directivityStep = Math.PI * binHz * elementMetres * paths.directivityCos[index] / speed;
  const directive = elementMetres > 0 && Math.abs(directivityStep) > 1e-12;
  const directivityStepRe = Math.cos(directivityStep);
  const directivityStepIm = Math.sin(directivityStep);
  let directivityRe = directivityStepRe;
  let directivityIm = directivityStepIm;

  const omegaStep = 2 * Math.PI * binHz;
  // A triple boom is the N-wave plus its middle shock (`tripleSpectrum`).
  const triple = pulseKind === PULSE_TRIPLE;
  const nWave = pulseKind === PULSE_NWAVE || triple;
  // The roar is framed as a unit impulse and convolved with its noise later (see FRAME_GROUPS).
  const noise = pulseKind === PULSE_NOISE;
  const duration = paths.duration[index];
  const pulseStep = omegaStep * duration;
  const pulseStepRe = Math.cos(pulseStep);
  const pulseStepIm = Math.sin(pulseStep);
  let pulseCos = pulseStepRe;
  let pulseSin = pulseStepIm;
  const middleStep = pulseStep * BOOSTER.middleShare;
  const middleStepRe = Math.cos(middleStep);
  const middleStepIm = Math.sin(middleStep);
  let middleCos = middleStepRe;
  let middleSin = middleStepIm;
  const friedlanderRe = sources.decay[sourceIndex] / duration;
  const subArrivalSets = [spreadArrivals, turbulence].filter(Boolean);
  const reals = spectra.map(spectrum => spectrum.real);
  const imaginaries = spectra.map(spectrum => spectrum.imaginary);

  for (let bin = 1; bin < limit; bin += 1) {
    const omega = omegaStep * bin;
    let re;
    let im;
    if (noise) {
      // A unit sample: the frame's synthesis multiplies by the sample rate.
      re = 1 / (binHz * size);
      im = 0;
    } else if (nWave) {
      const x = pulseStep * bin;
      if (x < SMALL_ARGUMENT) {
        re = 0;
        im = omega * duration * duration / 6;
      } else {
        const scale = 2 / (duration * omega * omega);
        re = pulseSin / omega + scale * (1 - pulseCos - x * pulseSin);
        im = (pulseCos - 1) / omega + scale * (pulseSin - x * pulseCos);
      }
      if (triple) {
        const { middleShare, middleRatio } = BOOSTER;
        if (x < SMALL_ARGUMENT) im -= omega * middleRatio * duration * duration * (1 - middleShare) * (3 * middleShare - 1) / 6;
        else [re, im] = tripleTerm(omega, pulseCos, pulseSin, middleCos, middleSin, re, im, middleShare, middleRatio);
        const nextMiddle = middleCos * middleStepRe - middleSin * middleStepIm;
        middleSin = middleCos * middleStepIm + middleSin * middleStepRe;
        middleCos = nextMiddle;
      }
      const nextCos = pulseCos * pulseStepRe - pulseSin * pulseStepIm;
      pulseSin = pulseCos * pulseStepIm + pulseSin * pulseStepRe;
      pulseCos = nextCos;
    } else {
      const sScale = friedlanderRe * friedlanderRe + omega * omega;
      const inverseRe = friedlanderRe / sScale;
      const inverseIm = -omega / sScale;
      re = inverseRe - (inverseRe * inverseRe - inverseIm * inverseIm) / duration;
      im = inverseIm - 2 * inverseRe * inverseIm / duration;
    }
    let factor = gain * smoothing[bin] * Math.exp(-pathLoss(bin, (layered ? binAbsorption(plan, bin) : absorption[bin]) * metres) - (underCanopy ? foliage.loss[bin] * underCanopy : 0));
    if (directive) {
      factor *= directivityIm / (directivityStep * bin);
      const nextRe = directivityRe * directivityStepRe - directivityIm * directivityStepIm;
      directivityIm = directivityRe * directivityStepIm + directivityIm * directivityStepRe;
      directivityRe = nextRe;
    }
    re *= factor;
    im *= factor;
    if (underCanopy) {
      const phase = -foliage.lag[bin] * underCanopy;
      const cos = Math.cos(phase);
      const sin = Math.sin(phase);
      const nextRe = re * cos - im * sin;
      im = re * sin + im * cos;
      re = nextRe;
    }
    for (let edge = 0; edge < edgeCount; edge += 1) {
      const [eRe, eIm] = knifeEdge(paths.edges[MAXIMUM_EDGES * index + edge] * Math.sqrt(bin * binHz));
      const nextRe = re * eRe - im * eIm;
      im = re * eIm + im * eRe;
      re = nextRe;
    }
    if (creepNepers > 0) {
      let loss = shadow.loss[bin];
      let lag = shadow.lag[bin];
      if (transitionHz) {
        const [softLoss, softLag] = softExponent(bin * binHz, transitionHz);
        loss += softLoss;
        lag += softLag;
      }
      const [cRe, cIm] = shadowFromExponent(loss, lag, beta, shadowFloor);
      const nextRe = re * cRe - im * cIm;
      im = re * cIm + im * cRe;
      re = nextRe;
    }
    for (const subArrivals of subArrivalSets) {
      const { gain: subGain, re: subRe, im: subIm, stepRe, stepIm, direct } = subArrivals;
      let sumRe = direct;
      let sumIm = 0;
      for (let k = 0; k < subGain.length; k += 1) {
        sumRe += subGain[k] * subRe[k];
        sumIm += subGain[k] * subIm[k];
        const nextRe = subRe[k] * stepRe[k] - subIm[k] * stepIm[k];
        subIm[k] = subRe[k] * stepIm[k] + subIm[k] * stepRe[k];
        subRe[k] = nextRe;
      }
      const nextRe = re * sumRe - im * sumIm;
      im = re * sumIm + im * sumRe;
      re = nextRe;
    }
    for (let end = 0; end < endCount; end += 1) {
      const { re: gridRe, im: gridIm, rotation } = ends[end];
      const position = gridPosition[bin];
      const lower = Math.floor(position);
      const mix = position - lower;
      const qRe = gridRe[lower] + (gridRe[lower + 1] - gridRe[lower]) * mix;
      const qIm = gridIm[lower] + (gridIm[lower + 1] - gridIm[lower]) * mix;
      // 1 + Q·e^(−iωΔ/c), with the delay's phase advanced by rotation.
      const fRe = 1 + qRe * rotation.re - qIm * rotation.im;
      const fIm = qRe * rotation.im + qIm * rotation.re;
      const nextRe = re * fRe - im * fIm;
      im = re * fIm + im * fRe;
      re = nextRe;
      const nextRotationRe = rotation.re * rotation.stepRe - rotation.im * rotation.stepIm;
      rotation.im = rotation.re * rotation.stepIm + rotation.im * rotation.stepRe;
      rotation.re = nextRotationRe;
    }
    if (ground || turbulent) {
      const position = gridPosition[bin];
      const lower = Math.floor(position);
      const mix = position - lower;
      let qRe = groundRe[lower] + (groundRe[lower + 1] - groundRe[lower]) * mix;
      let qIm = groundIm[lower] + (groundIm[lower + 1] - groundIm[lower]) * mix;
      if (reflectionScatter) {
        const share = groundScatter[lower] + (groundScatter[lower + 1] - groundScatter[lower]) * mix;
        const { gain: subGain, re: subRe, im: subIm, stepRe, stepIm } = reflectionScatter;
        for (let k = 0; k < subGain.length; k += 1) {
          qRe += share * subGain[k] * subRe[k];
          qIm += share * subGain[k] * subIm[k];
          const nextRe = subRe[k] * stepRe[k] - subIm[k] * stepIm[k];
          subIm[k] = subRe[k] * stepIm[k] + subIm[k] * stepRe[k];
          subRe[k] = nextRe;
        }
      }
      const nextRe = re * qRe - im * qIm;
      im = re * qIm + im * qRe;
      re = nextRe;
    }
    const outRe = re * phaseRe - im * phaseIm;
    const outIm = re * phaseIm + im * phaseRe;
    for (let channel = 0; channel < channels; channel += 1) {
      reals[channel][bin] += gains[channel] * outRe;
      imaginaries[channel][bin] += gains[channel] * outIm;
    }
    const nextPhaseRe = phaseRe * phaseStepRe - phaseIm * phaseStepIm;
    phaseIm = phaseRe * phaseStepIm + phaseIm * phaseStepRe;
    phaseRe = nextPhaseRe;
  }
}

/**
 * A scattered echo's sub-arrivals: seeded times across `spread` seconds, from half a merging bin
 * before its arrival, each of gain ±1/√PROPAGATION.scatterArrivals, as rotations that start at bin 1.
 */
function scatterArrivals(spread, seed, binHz) {
  const random = createRandom(seed >>> 0);
  const gain = new Float64Array(PROPAGATION.scatterArrivals);
  const re = new Float64Array(PROPAGATION.scatterArrivals);
  const im = new Float64Array(PROPAGATION.scatterArrivals);
  const stepRe = new Float64Array(PROPAGATION.scatterArrivals);
  const stepIm = new Float64Array(PROPAGATION.scatterArrivals);
  for (let k = 0; k < PROPAGATION.scatterArrivals; k += 1) {
    const delay = random() * spread - PROPAGATION.scatterBinSeconds / 2;
    gain[k] = (random() < .5 ? -1 : 1) / Math.sqrt(PROPAGATION.scatterArrivals);
    const step = -2 * Math.PI * binHz * delay;
    stepRe[k] = Math.cos(step); stepIm[k] = Math.sin(step);
    re[k] = stepRe[k]; im[k] = stepIm[k];
  }
  return { gain, re, im, stepRe, stepIm, direct: 0 };
}

/**
 * `count` seeded sub-arrivals of random sign and unit total energy, delayed exponentially with mean
 * `seconds` (at most FLIGHT.turbulentFront.longestRises means), as rotations from bin 1.
 */
function subArrivals(count, seconds, seed, binHz) {
  const random = createRandom(seed >>> 0);
  const gain = new Float64Array(count);
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  const stepRe = new Float64Array(count);
  const stepIm = new Float64Array(count);
  for (let k = 0; k < count; k += 1) {
    gain[k] = (random() < .5 ? -1 : 1) / Math.sqrt(count);
    const step = -2 * Math.PI * binHz * Math.min(FLIGHT.turbulentFront.longestRises, -Math.log(1 - random())) * seconds;
    stepRe[k] = Math.cos(step); stepIm[k] = Math.sin(step);
    re[k] = stepRe[k]; im[k] = stepIm[k];
  }
  return { gain, re, im, stepRe, stepIm };
}

/**
 * A boom's turbulent front (see FLIGHT.turbulentFront.arrivals): the direct front and seeded sub-arrivals of
 * zero sum whose energy is `share`² of the front's, delayed exponentially with mean `riseSeconds`, as rotations from bin 1.
 */
function turbulentFront(riseSeconds, share, seed, binHz) {
  const random = createRandom((seed ^ 0x5bd1e995) >>> 0);
  const gain = Float64Array.from({ length: FLIGHT.turbulentFront.arrivals }, () => normalDeviate(random));
  const mean = gain.reduce((sum, value) => sum + value, 0) / FLIGHT.turbulentFront.arrivals;
  const spread = Math.sqrt(gain.reduce((sum, value) => sum + (value - mean) ** 2, 0) / FLIGHT.turbulentFront.arrivals) || 1;
  const re = new Float64Array(FLIGHT.turbulentFront.arrivals);
  const im = new Float64Array(FLIGHT.turbulentFront.arrivals);
  const stepRe = new Float64Array(FLIGHT.turbulentFront.arrivals);
  const stepIm = new Float64Array(FLIGHT.turbulentFront.arrivals);
  for (let k = 0; k < FLIGHT.turbulentFront.arrivals; k += 1) {
    gain[k] = (gain[k] - mean) / spread * share / Math.sqrt(FLIGHT.turbulentFront.arrivals);
    const step = -2 * Math.PI * binHz * Math.min(FLIGHT.turbulentFront.longestRises, -Math.log(1 - random())) * riseSeconds;
    stepRe[k] = Math.cos(step); stepIm[k] = Math.sin(step);
    re[k] = stepRe[k]; im[k] = stepIm[k];
  }
  return { gain, re, im, stepRe, stepIm, direct: 1 };
}

/**
 * Fills `ends` with the ground images an echo carries at its source and receiver ends and returns
 * how many. A source within its linearization radius of the ground meets it while still a strong
 * shock, so its image merges with it as from rigid ground (class C).
 */
function echoEnds(ends, plan, scene, sources, sourceIndex, paths, index, metres, speed) {
  if (!scene.ground.enabled) return 0;
  let count = 0;
  for (let side = 0; side < 2; side += 1) {
    const lift = paths.endLift[2 * index + side];
    if (!(lift > 0) || lift / speed > PROPAGATION.endImageSeconds) continue;
    const rigid = isReflecting(scene.ground.type) || (side === 0 && paths.sourceHeight[index] < sources.linearRadiusMetres[sourceIndex]);
    const sine = paths.endSine[2 * index + side];
    const end = ends[count];
    for (let point = 0; point < GROUND_GRID_POINTS; point += 1) {
      const [qRe, qIm] = rigid ? [1, 0] : sphericalReflectionCoefficient(plan.groundFrequencies[point], scene.ground.type, sine, metres, speed);
      end.re[point] = qRe;
      end.im[point] = qIm;
    }
    // The delay's phase at bin 1, which the loop starts from, and its step.
    const step = -2 * Math.PI * plan.binHz * lift / speed;
    end.rotation = { re: Math.cos(step), im: Math.sin(step), stepRe: Math.cos(step), stepIm: Math.sin(step) };
    count += 1;
  }
  return count;
}

/** Inverse transform of a continuous-time spectrum sampled at bins: x[n] = fs · IDFT(X). */
/**
 * Two channels' frames from their half spectra in one inverse transform: both are real, so the
 * first enters as the signal's real part and the second as its imaginary part. Returns the first
 * frame in `first.real` and the second in `first.imaginary`; `second` is left as it was.
 */
function synthesizeFramePair(first, second, size, sampleRate) {
  const { real, imaginary } = first;
  for (let bin = 1; bin < size / 2; bin += 1) {
    const aRe = real[bin]; const aIm = imaginary[bin];
    const bRe = second.real[bin]; const bIm = second.imaginary[bin];
    // A + iB at bin, and conj(A) + i·conj(B) at its mirror.
    real[bin] = aRe - bIm;
    imaginary[bin] = aIm + bRe;
    real[size - bin] = aRe + bIm;
    imaginary[size - bin] = bRe - aIm;
  }
  real[0] = 0;
  imaginary[0] = 0;
  imaginary[size / 2] = second.real[size / 2];
  fft(real, imaginary, true);
  for (let index = 0; index < size; index += 1) { real[index] *= sampleRate; imaginary[index] *= sampleRate; }
  return [real, imaginary];
}

function synthesizeFrame(real, imaginary, size, sampleRate) {
  for (let bin = 1; bin < size / 2; bin += 1) {
    real[size - bin] = real[bin];
    imaginary[size - bin] = -imaginary[bin];
  }
  real[0] = 0;
  imaginary[0] = 0;
  imaginary[size / 2] = 0;
  fft(real, imaginary, true);
  for (let index = 0; index < size; index += 1) real[index] *= sampleRate;
  return real;
}

/**
 * Renders the pressure contribution of the paths whose arrival lies in [fromSeconds, toSeconds)
 * at one receiver: p_r(t) = Σ (s_i * h_i,r)(t). Paths are gathered into overlapping frames of 2H
 * samples at hop H; each frame is one inverse FFT, overlap-added in Float64. Time zero is the
 * scene's emission origin. Returns the segment's first sample index and its samples.
 */
export function renderReceiverRange(preparedEmitters, receiver, scene, { fromSeconds = -Infinity, toSeconds = Infinity, onProgress = null, paths: traced = null } = {}) {
  const sampleRate = scene.render.sampleRate;
  const profile = soundSpeedProfile(scene.air);
  const speed = profile.groundSpeed;
  // Progress as a share: tracing the paths, then rendering them.
  // Paths already traced for this receiver, as by the arrival table, are not traced again.
  const traceShare = traced ? 0 : TRACE_SHARE;
  const paths = traced ?? receiverPaths(preparedEmitters, receiver, scene, { onProgress: onProgress && (share => onProgress(TRACE_SHARE * share)) });
  const receiverZ = onGround(terrainSurface(scene.terrain), receiver.positionMetres).z;
  const plans = preparedEmitters.flatMap((prepared, emitterIndex) => Array.from({ length: FRAME_GROUPS }, (_, part) => framePlan(prepared, FRAME_GROUPS * emitterIndex + part, paths, sampleRate, profile, scene, receiverZ)));
  const selected = [];
  for (let index = 0; index < paths.count; index += 1) {
    if (paths.seconds[index] >= fromSeconds && paths.seconds[index] < toSeconds) selected.push(index);
  }
  const frameOf = new Float64Array(paths.count);
  let first = Infinity;
  let last = -Infinity;
  let nonlinearPaths = 0;
  for (const index of selected) {
    const plan = plans[frameGroup(paths, index)];
    const frame = Math.floor((paths.seconds[index] * sampleRate - plan.preRoll) / plan.hop);
    frameOf[index] = frame;
    first = Math.min(first, frame * plan.hop);
    last = Math.max(last, frame * plan.hop + plan.size);
    if (paths.metres[index] < pathSources(preparedEmitters, paths, index).linearRadiusMetres[paths.source[index]]) nonlinearPaths += 1;
  }
  const order = scene.render.ambisonicOrder;
  const channels = channelCount(order);
  if (!selected.length) return { startSample: 0, channels: Array.from({ length: channels }, () => new Float64Array(0)), nonlinearPaths: 0, pathCount: 0 };
  if ((last - first) / sampleRate > RENDER.maximumSeconds) {
    throw new RangeError(`Arrivals at ${receiver.name} span ${((last - first) / sampleRate).toFixed(1)} s; the limit is ${RENDER.maximumSeconds} s.`);
  }
  // Each emitter's roar, which its impulses are convolved with; its ground reflection has a roar of its
  // own seed, because the roar comes from the whole moving fireball and debris cloud rather than a
  // point, and so does not interfere with its reflection (class C).
  const roars = preparedEmitters.map(({ sources }) => {
    let index = 0;
    while (index < sources.length && sources.pulse[index] !== PULSE_NOISE) index += 1;
    if (index === sources.length) return null;
    const seconds = sources.durationSeconds[index];
    return [0, 1].map(part => ({ samples: fireballSamples((sources.noiseSeed[index] + part) >>> 0, seconds, sampleRate), impulses: null }));
  });
  const roarLength = Math.max(0, ...roars.map(roar => (roar ? roar[0].samples.length : 0)));
  const outputs = Array.from({ length: channels }, () => new Float64Array(last - first + roarLength));
  const gains = new Float64Array(channels);
  selected.sort((a, b) => frameGroup(paths, a) - frameGroup(paths, b) || frameOf[a] - frameOf[b] || a - b);
  const groundRe = new Float64Array(GROUND_GRID_POINTS);
  const groundIm = new Float64Array(GROUND_GRID_POINTS);
  const ends = [0, 1].map(() => ({ re: new Float64Array(GROUND_GRID_POINTS), im: new Float64Array(GROUND_GRID_POINTS), rotation: null }));
  let cursor = 0;
  while (cursor < selected.length) {
    const group = frameGroup(paths, selected[cursor]);
    const emitterIndex = paths.emitter[selected[cursor]];
    const frame = frameOf[selected[cursor]];
    const plan = plans[group];
    const spectra = Array.from({ length: channels }, () => ({ real: new Float64Array(plan.size), imaginary: new Float64Array(plan.size) }));
    while (cursor < selected.length && frameGroup(paths, selected[cursor]) === group && frameOf[selected[cursor]] === frame) {
      const index = selected[cursor];
      const sources = pathSources(preparedEmitters, paths, index);
      const seed = (Math.imul(preparedEmitters[emitterIndex].emitter.seed ^ 0x9e3779b9, 31) + paths.source[index]) >>> 0;
      encodeDirection(paths.direction[3 * index], paths.direction[3 * index + 1], paths.direction[3 * index + 2], order, gains);
      accumulatePath(spectra, gains, plan, sources, paths.source[index], paths, index, paths.seconds[index] * sampleRate - frame * plan.hop, scene, speed, groundRe, groundIm, ends, seed, receiver.positionMetres.z, receiverZ);
      cursor += 1;
    }
    const at = frame * plan.hop - first;
    const part = group % FRAME_GROUPS - ROAR_GROUP;
    let target = outputs;
    if (part >= 0) {
      const roar = roars[emitterIndex][part];
      roar.impulses ??= Array.from({ length: channels }, () => new Float64Array(last - first));
      target = roar.impulses;
    }
    for (let channel = 0; channel < channels; channel += 2) {
      const blocks = channel + 1 < channels ? synthesizeFramePair(spectra[channel], spectra[channel + 1], plan.size, sampleRate)
        : [synthesizeFrame(spectra[channel].real, spectra[channel].imaginary, plan.size, sampleRate)];
      blocks.forEach((block, part) => {
        const output = target[channel + part];
        for (let sample = 0; sample < plan.size; sample += 1) output[at + sample] += block[sample];
      });
    }
    onProgress?.(traceShare + (1 - traceShare) * cursor / selected.length);
  }
  // The roar is linear in what arrives, so each range adds its own and their sum is exact. The
  // diffuse tails are added once to the sum of the ranges (combineWithTails).
  for (const roar of roars) {
    for (const { samples, impulses } of roar ?? []) {
      if (impulses) convolveAdd(outputs, impulses, samples);
    }
  }
  return { startSample: first, channels: outputs, nonlinearPaths, pathCount: selected.length };
}

/** Whether the scene's receivers hear diffuse tails: the forest's, or the surroundings' over level ground. */
export function hasTails(scene) {
  return scene.ground.forest || surroundingsTail(scene);
}

// Over loaded terrain its echoes are the surroundings; over level ground a diffuse tail stands for them.
const surroundingsTail = scene => scene.ground.surroundings && !(echoesActive(scene) && !terrainSurface(scene.terrain).flat);

/**
 * The responses of the diffuse tails at a receiver, per channel, or of its channels [first, last);
 * null without tails.
 */
export function tailResponses(receiver, scene, channels = [0, channelCount(scene.render.ambisonicOrder)]) {
  if (!hasTails(scene)) return null;
  const count = channelCount(scene.render.ambisonicOrder);
  const { sampleRate } = scene.render;
  return {
    forest: scene.ground.forest ? forestResponses(forestSeed(receiver.id), count, sampleRate, channels, scene.ground.forestDensity) : null,
    surroundings: surroundingsTail(scene) ? surroundingsResponses(forestSeed(receiver.id), count, sampleRate, channels) : null
  };
}

/** Responses made in shares of channels, in channel order, put together. */
export function joinResponses(shares) {
  const join = kind => (shares[0][kind] ? shares.flatMap(share => share[kind]) : null);
  return { forest: join('forest'), surroundings: join('surroundings') };
}

/** Samples the tails reach beyond the sound that excites them. */
export const tailSamples = responses => (responses?.forest?.[0].length ?? 0) + (responses?.surroundings?.[0].length ?? 0);

/**
 * Sums rendered segments in the given order into Float64 channels from the earliest segment's
 * start, followed by `room` silent samples for the tails. Empty when no segment holds a sample.
 */
export function sumSegments(segments, sampleRate, room = 0) {
  const present = segments.filter(segment => segment.channels[0].length);
  const count = segments[0]?.channels.length ?? 1;
  if (!present.length) return { startSample: 0, channels: Array.from({ length: count }, () => new Float64Array(0)) };
  const start = Math.min(...present.map(segment => segment.startSample));
  const end = Math.max(...present.map(segment => segment.startSample + segment.channels[0].length));
  if ((end - start) / sampleRate > RENDER.maximumSeconds) throw new RangeError(`The arrivals span ${((end - start) / sampleRate).toFixed(1)} s; the limit is ${RENDER.maximumSeconds} s.`);
  const channels = Array.from({ length: count }, (_, channel) => {
    const sum = new Float64Array(end - start + room);
    for (const segment of present) {
      const offset = segment.startSample - start;
      const samples = segment.channels[channel];
      for (let index = 0; index < samples.length; index += 1) sum[offset + index] += samples[index];
    }
    return sum;
  });
  return { startSample: start, channels };
}

/**
 * Stretches [from, to) of `length` samples, `count` of about equal length or fewer, whose tails are
 * computed apart and added up (`diffuseTails` is linear). Each stretch transforms the whole responses
 * however short it is, so none is made shorter than `shortest` samples, the tails' length.
 */
export function tailStretches(length, count, shortest = 1) {
  const parts = Math.max(1, Math.min(count, Math.floor(length / Math.max(1, shortest))));
  return Array.from({ length: parts }, (_, part) => [Math.floor(part * length / parts), Math.floor((part + 1) * length / parts)]);
}

/** Adds a stretch's tails, which begin at its first sample `from`, to summed channels. */
export function addTails(sum, from, tails) {
  tails.forEach((tail, channel) => {
    const target = sum.channels[channel];
    for (let index = 0; index < tail.length; index += 1) target[from + index] += tail[index];
  });
}

/**
 * Float32 channels from summed ones, checking every sample. Channel 0 is the omnidirectional
 * pressure W. Returns the channels, their start time, and the peak of W in pascals.
 */
export function finishSum(sum, sampleRate) {
  let peakPa = 0;
  const channels = sum.channels.map((samples, channel) => {
    const result = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      if (!Number.isFinite(samples[index])) throw new RangeError('The render produced a non-finite sample.');
      result[index] = samples[index];
      if (channel === 0) peakPa = Math.max(peakPa, Math.abs(samples[index]));
    }
    return result;
  });
  return { startSeconds: sum.channels[0].length ? sum.startSample / sampleRate : 0, channels, peakPa };
}

/** Sums rendered segments in the given order into checked Float32 channels, without tails. */
export function combineSegments(segments, sampleRate) {
  return finishSum(sumSegments(segments, sampleRate), sampleRate);
}

/**
 * Sums rendered segments and adds the receiver's diffuse tails to the sum, computed over `stretches`
 * stretches of its pressure in turn, as the page does on several workers.
 */
export function combineWithTails(segments, receiver, scene, stretches = 1) {
  const { sampleRate } = scene.render;
  const responses = tailResponses(receiver, scene);
  const sum = sumSegments(segments, sampleRate, tailSamples(responses));
  const length = sum.channels[0].length - tailSamples(responses);
  if (responses && length > 0) {
    const pressure = sum.channels[0].slice(0, length);
    for (const [from, to] of tailStretches(length, stretches)) addTails(sum, from, diffuseTails(pressure.subarray(from, to), responses, sum.channels.length));
  }
  return finishSum(sum, sampleRate);
}

/**
 * Time boundaries that split all arrivals at every receiver into `count` parts of equal size. Pass
 * the receivers' arrival tables when they exist, so that their paths are not traced again.
 */
export function partitionSeconds(preparedEmitters, scene, count, tables = scene.receivers.map(receiver => arrivalTable(preparedEmitters, receiver, scene))) {
  const times = new Float64Array(tables.reduce((sum, table) => sum + table.count, 0));
  let at = 0;
  for (const table of tables) { times.set(table.seconds, at); at += table.count; }
  times.sort();
  const boundaries = [-Infinity];
  for (let part = 1; part < count; part += 1) boundaries.push(times[Math.floor(part / count * times.length)] ?? Infinity);
  boundaries.push(Infinity);
  return boundaries;
}

/** The complete render at one receiver, in one thread. */
export function renderReceiver(preparedEmitters, receiver, scene) {
  const segment = renderReceiverRange(preparedEmitters, receiver, scene);
  const combined = combineWithTails([segment], receiver, scene);
  return {
    receiverId: receiver.id,
    sampleRate: scene.render.sampleRate,
    ...combined,
    samples: combined.channels[0],
    speedOfSound: soundSpeedProfile(scene.air).groundSpeed,
    arrivals: arrivalTable(preparedEmitters, receiver, scene),
    nonlinearPaths: segment.nonlinearPaths,
    modelVersion: MODEL_VERSION
  };
}
