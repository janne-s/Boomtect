import { airAtHeight, atmosphericAbsorptionNepersPerMetre, pressureAtHeightPa, temperatureAtHeightKelvin } from '../shared/domain/air.js';
import { ambisonicDirection, channelCount, encodeDirection } from '../shared/domain/ambisonics.js';
import { BOOSTER, FLIGHT, GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, GROUND, KELVIN_OFFSET, MODEL_VERSION, PROPAGATION, RENDER, VIEW } from './constants.js';
import { emitterSourceTable } from './emitters.js';
import { edgeField } from '../shared/domain/diffraction.js';
import { diffuseTails, foliageExponent, foliageMetres, forestResponses, forestSeed, surroundingsResponses } from '../shared/domain/forest.js';
import { PULSE_FRIEDLANDER, PULSE_NOISE, PULSE_NWAVE, PULSE_TRIPLE, sourcePosition, sourceTable } from './source-table.js';
import { secondaryShockDelay } from './explosives.js';
import { fireballSamples } from './fireball.js';
import { boosterPath, flightBooms, flightMembers, flightPath, whipBody, whipPath, withApproach } from './flight.js';
import { meteorBooms, meteorTrack, showerMembers } from './meteor.js';
import { previewQuality } from '../shared/domain/render-cost.js';
import { secondaryBooms } from './secondary.js';
import { onGround, terrainSurface } from '../shared/domain/terrain.js';
import { arrivalSector, echoField, echoPaths, sourceCells } from '../shared/domain/terrain-echoes.js';
import { meanPlaneFrame, shieldingEdges, terrainMultipleReflections, terrainReflection } from '../shared/domain/terrain-propagation.js';
import { convolveAdd, fft, nextPowerOfTwo } from '../shared/domain/fft.js';
import { creepingTransitionHz, cubeRootExponent, softExponent } from '../shared/domain/creeping.js';
import { isReflecting, planeReflectionMagnitude, sphericalReflectionCoefficient } from '../shared/domain/ground.js';
import { weakShockPulse } from './lightning.js';
import { riseSmoothing, tripleTerm } from './pulses.js';
import { createRandom, normalDeviate } from '../shared/domain/random.js';
import {
  creepingCoefficient, inShadow, pathProfile, PATH_DIRECT, PATH_ECHO, PATH_GROUND, PATH_SCATTER, PATH_SHADOW, rayBetween, reflectedRay, shadowPath, soundSpeedProfile, speedAt
} from '../shared/domain/refraction.js';

const PRE_ROLL_SAMPLES = 512;
const MAXIMUM_EDGES = 3;
const EDGE_KEYS = Object.freeze(['factor', 'spread', 'rise', 'radiusRatio']);
const EDGE_WIDTH = EDGE_KEYS.length;
function pathEdge(paths, index, edge) {
  const at = (MAXIMUM_EDGES * index + edge) * EDGE_WIDTH;
  return Object.fromEntries(EDGE_KEYS.map((key, offset) => [key, paths.edges[at + offset]]));
}
const TAIL_GUARD_SAMPLES = 2048;
const NEGLIGIBLE_SMOOTHING = 1e-7;
const GROUND_GRID_POINTS = 64;
const ABSORPTION_LAYER_METRES = 250;
const ABSORPTION_GRID_POINTS = 128;
const RISE_TIME_PER_SIGMA = 2.5631;
/** Class A. */
const AIR_NONLINEARITY = (GAMMA_AIR + 1) / 2;
const CREEPING_RADII = 8;
const groundScatter = new Float64Array(GROUND_GRID_POINTS);
const forestRe = new Float64Array(GROUND_GRID_POINTS);
const forestIm = new Float64Array(GROUND_GRID_POINTS);
const SMALL_ARGUMENT = 1e-4;

/** An upper bound measured over 0.2–60 km and 2–12 K/km. */
export function shadowTailSeconds(nepersAtOneHertz) {
  if (!(nepersAtOneHertz > 0)) return 0;
  return .1 + .6 * creepingBeta(nepersAtOneHertz) ** .65;
}

const FRAME_GROUPS = 5;
const ROAR_GROUP = 3;
const TRACE_SHARE = .3;
const isEcho = kind => kind === PATH_ECHO || kind === PATH_SCATTER;
const frameGroup = (paths, index) => FRAME_GROUPS * paths.emitter[index]
  + (paths.roar[index] ? ROAR_GROUP + paths.roar[index] - 1 : isEcho(paths.kind[index]) ? 2 : paths.creepNepers[index] > 0 ? 1 : 0);
const pathSources = (preparedEmitters, paths, index) => (isEcho(paths.kind[index]) ? paths.cells[paths.emitter[index]] : preparedEmitters[paths.emitter[index]].sources);

export const echoesActive = scene => Boolean(scene.terrain?.enabled && scene.terrain.echoes);

export function previewScene(scene) {
  const preview = structuredClone(scene);
  preview.render.preview = true;
  preview.render.quality = previewQuality(preview.render.quality);
  return preview;
}

const echoCellMetres = scene => scene.terrain.echoCellMetres * scene.render.quality.echoCellScale;

const cutoffNepers = scene => -scene.render.quality.cutoffDecibels * Math.LN10 / 20;

export function prepareScene(scene) {
  const surface = terrainSurface(scene.terrain);
  const echoes = echoesActive(scene) && !surface.flat;
  const prepared = scene.emitters.filter(emitter => emitter.enabled).map(emitter => {
    const { sources, rows } = emitterSourceTable(emitter, scene.air, surface, scene.render.quality);
    if (emitter.kind === 'booster') return { emitter, sources, cells: null, echoRows: [], flights: [{ flight: emitter, path: boosterPath(emitter, scene.air, surface), booms: flightBooms, pulse: 'triple', secondary: true }] };
    if (emitter.kind === 'whip') return { emitter, sources, cells: null, echoRows: [], flights: [{ flight: whipBody(emitter), path: whipPath(emitter, scene.air, surface), booms: flightBooms }] };
    if (emitter.kind === 'flight' || emitter.kind === 'formation') {
      return { emitter, sources, cells: null, echoRows: [], flights: flightMembers(emitter).map(flight => ({ flight, path: withApproach(flightPath(flight, scene.air), scene.air), booms: flightBooms, secondary: true })) };
    }
    if (emitter.kind === 'meteor' || emitter.kind === 'shower') {
      const flights = showerMembers(emitter).map(meteor => ({ flight: meteor, path: meteorTrack(meteor), booms: meteorBooms }));
      return { emitter, sources, cells: null, echoRows: rows.slice(flights.length), flights };
    }
    return { emitter, sources, cells: echoes ? sourceCells(sources, echoCellMetres(scene)) : null };
  });
  const count = prepared.reduce((sum, item) => sum + item.sources.length, 0);
  if (count > RENDER.maximumSources) throw new RangeError(`The scene has ${count} point sources; the limit is ${RENDER.maximumSources}.`);
  return prepared;
}

/** Class C. */
function airCeiling(air, top) {
  if (air.groundLayerMetres > 0 && top <= air.groundLayerMetres) return air.groundLayerMetres;
  return air.tropopauseMetres > 0 ? air.tropopauseMetres : Infinity;
}

/** Class A. */
function receiverImpedanceFactor(air, profile, heightMetres) {
  if (!air.refraction) return 1;
  const density = pressureAtHeightPa(air, heightMetres) / pressureAtHeightPa(air, 0) * temperatureAtHeightKelvin(air, 0) / temperatureAtHeightKelvin(air, heightMetres);
  return Math.sqrt(density * speedAt(profile, heightMetres) / profile.groundSpeed);
}

const PATH_WIDTHS = Object.freeze({ direction: 3, edges: MAXIMUM_EDGES * EDGE_WIDTH, endLift: 2, endSine: 2 });

const PATH_ARRAYS = Object.freeze({
  emitter: Uint16Array,
  source: Uint32Array,
  kind: Uint8Array,
  seconds: Float64Array,
  metres: Float64Array,
  spreadMetres: Float64Array,
  creepNepers: Float64Array,
  creepRadius: Float64Array,
  directivityCos: Float64Array,
  cosIncidence: Float64Array,
  duration: Float64Array,
  amplitudeScale: Float64Array,
  direction: Float64Array,
  edgeCount: Uint8Array,
  edges: Float64Array,
  bounces: Uint8Array,
  endLift: Float64Array,
  endSine: Float64Array,
  sourceHeight: Float64Array,
  foliageMetres: Float64Array,
  roar: Uint8Array,
  timeSpread: Float64Array,
  height: Float64Array,
  absorptionExcess: Float64Array,
  /** Class C. */
  aloft: Uint8Array
});

function pathTable(capacity) {
  const paths = { count: 0 };
  for (const [key, Type] of Object.entries(PATH_ARRAYS)) paths[key] = new Type(Math.max(1, capacity) * (PATH_WIDTHS[key] ?? 1));
  return paths;
}

/** Class C: the cone's front taken as a sphere. */
function tracingFrame(preparedEmitters, receiver, scene) {
  const profile = soundSpeedProfile(scene.air);
  const surface = terrainSurface(scene.terrain);
  const receiverPosition = onGround(surface, receiver.positionMetres);
  const booms = preparedEmitters.map(prepared => prepared.flights?.map(({ flight, path, booms: find, secondary }) => [
    ...find(path, flight, receiverPosition, profile, scene.air), ...(secondary ? secondaryBooms(path, flight, receiverPosition, scene.air) : [])
  ]) ?? null);
  const traceEchoes = echoesActive(scene) && !surface.flat;
  const cells = preparedEmitters.map((prepared, emitterIndex) => {
    if (!prepared.flights) return prepared.cells;
    if (!traceEchoes) return null;
    const rows = [...prepared.echoRows, ...booms[emitterIndex].flatMap((list, member) => list.filter(boom => !boom.secondary).map(boom => boomEchoRow(boom, member, prepared.flights[member].pulse)))];
    return rows.length ? sourceCells(sourceTable(rows), echoCellMetres(scene)) : null;
  });
  return { profile, surface, receiverPosition, booms, cells, ground: scene.ground.enabled };
}

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
    edges.forEach((edge, edgeIndex) => { paths.edges.set(EDGE_KEYS.map(key => edge[key]), (MAXIMUM_EDGES * index + edgeIndex) * EDGE_WIDTH); });
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
    paths.height[index] = path.topMetres ?? from.z;
    paths.absorptionExcess[index] = path.absorptionExcess ?? 0;
    paths.aloft[index] = path.topMetres === undefined ? 0 : 1;
    paths.foliageMetres[index] = !treeHeight ? 0 : isEcho(kind) ? path.foliageMetres
      : foliageMetres(path.metres, from.z - surface.heightAt(from.x, from.y), receiverLift, treeHeight);
    paths.direction.set(path.metres > 0 ? ambisonicDirection(-arrival.x, -arrival.y, -arrival.z) : [1, 0, 0], 3 * index);
    if (path.durationSeconds !== undefined) {
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

const partRange = (count, part, parts) => [Math.floor(count * part / parts), Math.floor(count * (part + 1) / parts)];

export function tracePart(preparedEmitters, receiver, scene, { part = 0, parts = 1, onProgress = null } = {}) {
  const frame = tracingFrame(preparedEmitters, receiver, scene);
  const { profile, surface, receiverPosition, booms, cells, ground } = frame;
  const sourceCount = preparedEmitters.reduce((sum, item) => sum + item.sources.length, 0);
  const placeCount = cells.reduce((sum, table) => sum + (table ? table.places.length : 0), 0);
  const [sourceStart, sourceEnd] = partRange(sourceCount, part, parts);
  const [placeStart, placeEnd] = partRange(placeCount, part, parts);
  const units = sourceEnd - sourceStart + placeEnd - placeStart;
  const every = Math.max(1, Math.floor(units / 100));
  let done = 0;
  const tick = onProgress ? () => { done += 1; if (done % every === 0) onProgress(done / units); } : () => {};

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
          if (boom.secondary) {
            const aloft = { ...boom.ray, ...shared, overpressurePa: boom.overpressurePa * boom.focus, topMetres: boom.topMetres, absorptionExcess: boom.absorptionExcess };
            add(emitterIndex, sourceIndex, sources, PATH_DIRECT, aloft);
            if (!ground) continue;
            // Class C: level ground under the receiver.
            const sine = -boom.ray.arrival.z;
            const lift = 2 * Math.max(0, receiverPosition.z - surface.heightAt(receiverPosition.x, receiverPosition.y)) * sine;
            add(emitterIndex, sourceIndex, sources, PATH_GROUND, {
              ...aloft, seconds: boom.ray.seconds + lift / speedAt(profile, 0), metres: boom.ray.metres + lift, spreadMetres: boom.ray.spreadMetres + lift,
              arrival: { ...boom.ray.arrival, z: sine }, groundSine: sine
            });
            continue;
          }
          if (boom.shadow) {
            add(emitterIndex, sourceIndex, sources, PATH_SHADOW, {
              ...boom.ray, ...shared, overpressurePa: boom.overpressurePa * boom.focus,
              creepNepers: creepingCoefficient(boom.along) * boom.ray.creepMetres, creepRadius: boom.along.groundSpeed / -boom.along.gradient
            });
            continue;
          }
          add(emitterIndex, sourceIndex, sources, PATH_DIRECT, { ...boom.ray, ...shared, overpressurePa: boom.overpressurePa * boom.focus });
          if (!ground) continue;
          // The ground model applies K_R, so it is counted once.
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

function tracePoint(frame, scene, add, emitterIndex, sourceIndex, sources) {
  const { profile, surface, receiverPosition, ground } = frame;
  const position = sourcePosition(sources, sourceIndex);
  const along = pathProfile(profile, position, receiverPosition);
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
  // Class C.
  const reflected = surface.flat ? reflectedRay(along, position, receiverPosition) : terrainReflection(along, surface, position, receiverPosition);
  if (reflected) add(emitterIndex, sourceIndex, sources, PATH_GROUND, reflected, edges);
  // Class C over terrain.
  if (along.gradient > 0) {
    const ceiling = airCeiling(scene.air, Math.max(position.z, receiverPosition.z));
    for (const ray of terrainMultipleReflections(along, surface, position, receiverPosition)) {
      const apex = along.groundSpeed / along.gradient * (1 / Math.sqrt(1 - ray.groundSine ** 2) - 1);
      if (apex <= ceiling) add(emitterIndex, sourceIndex, sources, PATH_GROUND, ray, edges);
    }
  }
}

function appendPaths(target, source) {
  if (!source?.count) return;
  for (const key of Object.keys(PATH_ARRAYS)) {
    const width = PATH_WIDTHS[key] ?? 1;
    target[key].set(source[key].subarray(0, source.count * width), target.count * width);
  }
  target.count += source.count;
}

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
  const specularCount = parts.reduce((sum, part) => sum + part.specular.reduce((total, table) => total + (table?.count ?? 0), 0), 0);
  const scatteredCount = merged.reduce((sum, sums) => sum + sums.size, 0);
  if (parts.length === 1 && !specularCount && !scatteredCount) return { ...parts[0].direct, cells: frame.cells };
  const paths = pathTable(parts.reduce((sum, part) => sum + part.direct.count, 0) + specularCount + scatteredCount);
  for (const part of parts) appendPaths(paths, part.direct);
  const add = pathWriter(frame, scene, paths);
  frame.cells.forEach((table, emitterIndex) => {
    for (const part of parts) appendPaths(paths, part.specular[emitterIndex]);
    for (const sum of merged[emitterIndex].values()) add(emitterIndex, sum.cell, table, PATH_SCATTER, mergedPath(sum, table));
  });
  paths.cells = frame.cells;
  return paths;
}

export function receiverPaths(preparedEmitters, receiver, scene, { onProgress = null } = {}) {
  return assemblePaths(preparedEmitters, receiver, scene, [tracePart(preparedEmitters, receiver, scene, { onProgress })]);
}

export function compactPaths(paths) {
  const compact = { count: paths.count, cells: paths.cells };
  for (const [key, array] of Object.entries(paths)) {
    if (ArrayBuffer.isView(array)) compact[key] = array.subarray(0, paths.count * (PATH_WIDTHS[key] ?? 1));
  }
  return { paths: compact, buffers: Object.values(compact).filter(ArrayBuffer.isView).map(array => array.buffer) };
}

export function airShockImpedance(air) {
  const density = air.pressureKpa * 1000 / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * (air.temperatureCelsius + KELVIN_OFFSET));
  return density * soundSpeedProfile(air).groundSpeed ** 3;
}

/** Class B: weak-shock aging of a spherical wave (Whitham 1956; Pierce, Acoustics, ch. 11). */
export function blastStretch(sources, index, metres, shockImpedance, heightMetres) {
  const r0 = sources.linearRadiusMetres[index];
  const T0 = sources.durationSeconds[index];
  if (!(metres > r0 && r0 > 0 && T0 > 0)) return 1;
  const p0 = sources.amplitudePaMetres[index] / r0 * (heightMetres < r0 ? PROPAGATION.mergedFrontFactor : 1);
  const oldAge = T0 * p0 * r0 / (PROPAGATION.oldAgeDurationRatio * PROPAGATION.shockRisePascalSeconds);
  const sigma = AIR_NONLINEARITY * p0 * r0 / (shockImpedance * T0);
  return Math.sqrt(1 + sigma * Math.log(Math.min(metres, oldAge) / r0));
}

function boomEchoRow(boom, member, pulse = 'n-wave') {
  return {
    flash: member, positionMetres: boom.point, direction: null, elementMetres: 0, emissionSeconds: boom.emissionSeconds,
    amplitudePaMetres: boom.overpressurePa * boom.focus * boom.ray.metres, pulse,
    durationSeconds: boom.durationSeconds, decay: 0, spanSeconds: boom.durationSeconds, linearRadiusMetres: 0, flight: true
  };
}

/** Ground taken level at the ends, class C; the image delay class B. */
function endImages(path, sourceHeight, receiverHeight, treeHeight) {
  const sourceSine = Math.abs(path.departure.z);
  const receiverSine = Math.abs(path.arrival.z);
  const [down, up] = path.legMetres;
  const foliage = treeHeight ? foliageMetres(down, sourceHeight, 0, treeHeight) + foliageMetres(up, 0, receiverHeight, treeHeight) : 0;
  return { sourceHeight, sourceSine, receiverSine, sourceLift: 2 * sourceHeight * sourceSine, receiverLift: 2 * receiverHeight * receiverSine, foliageMetres: foliage };
}

/** Class C. A mean arrival per bin would space the paths evenly and sound as a tone at 1/scatterBinSeconds. */
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
    timeSpread: entry.spreadSeconds / energy + PROPAGATION.scatterBinSeconds
  };
}

function edgeDecibels(paths, index, frequencyHz) {
  let decibels = 0;
  for (let edge = 0; edge < paths.edgeCount[index]; edge += 1) {
    decibels += 20 * Math.log10(Math.hypot(...edgeField(pathEdge(paths, index, edge), frequencyHz)));
  }
  return decibels;
}

export function arrivalTable(preparedEmitters, receiver, scene, options = {}) {
  const paths = options.paths ?? receiverPaths(preparedEmitters, receiver, scene, options);
  const heights = new Float32Array(paths.count);
  const levels = new Float32Array(paths.count);
  const bearings = new Float32Array(paths.count);
  const elevations = new Float32Array(paths.count);
  const floor = 10 ** (-scene.air.shadowFloorDecibels / 20);
  const soft = scene.ground.enabled && !isReflecting(scene.ground.type);
  const speed = soundSpeedProfile(scene.air).groundSpeed;
  const transitions = new Map();
  const diagramCreep = radius => {
    if (!soft) return 0;
    const key = radius.toPrecision(4);
    if (!transitions.has(key)) transitions.set(key, creepingTransitionHz(GROUND.flowResistivity[scene.ground.type], speed, radius));
    return transitions.get(key);
  };
  for (let index = 0; index < paths.count; index += 1) {
    const sources = pathSources(preparedEmitters, paths, index);
    heights[index] = paths.height[index];
    bearings[index] = ((Math.atan2(-paths.direction[3 * index + 1], paths.direction[3 * index]) * 180 / Math.PI) + 360) % 360;
    elevations[index] = Math.asin(Math.max(-1, Math.min(1, paths.direction[3 * index + 2]))) * 180 / Math.PI;
    levels[index] = 20 * Math.log10(sources.amplitudePaMetres[paths.source[index]] * paths.amplitudeScale[index] / Math.max(paths.spreadMetres[index], 1e-3))
      + (paths.creepNepers[index] > 0 ? 20 * Math.log10(Math.hypot(...shadowResponse(VIEW.arrivalDiagramHz, paths.creepNepers[index], floor, diagramCreep(paths.creepRadius[index])))) : 0)
      + edgeDecibels(paths, index, VIEW.arrivalDiagramHz);
  }
  return { count: paths.count, seconds: paths.seconds.slice(0, paths.count), metres: paths.metres.slice(0, paths.count), heights, levels, bearings, elevations, kinds: paths.kind.slice(0, paths.count) };
}

/** Class B: Clifford & Lataitis 1983, via Salomons 2001; to verify. */
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

export function frameExtents(preparedEmitters, paths) {
  const extents = Array.from({ length: FRAME_GROUPS * preparedEmitters.length }, () => ({ longestSpan: 0, largestCreep: 0, smallestRadius: Infinity, largestRadius: 0, highest: -Infinity }));
  for (let index = 0; index < paths.count; index += 1) {
    const extent = extents[frameGroup(paths, index)];
    const prepared = preparedEmitters[paths.emitter[index]];
    const sources = isEcho(paths.kind[index]) ? paths.cells[paths.emitter[index]] : prepared.sources;
    const source = paths.source[index];
    const span = paths.roar[index] ? 0 : sources.relaxationRadius[source] > 0 ? paths.duration[index]
      : sources.pulse[source] === PULSE_FRIEDLANDER ? sources.spanSeconds[source] * paths.duration[index] / sources.durationSeconds[source]
        : Math.max(sources.spanSeconds[source], sources.flight[source] ? paths.duration[index] : 0);
    extent.longestSpan = Math.max(extent.longestSpan, span + paths.timeSpread[index] + FLIGHT.turbulentFront.longestRises * ((sources.flight[source] ? prepared.emitter.riseTimeSeconds : 0) + GROUND.scatterSeconds));
    extent.largestCreep = Math.max(extent.largestCreep, paths.creepNepers[index]);
    if (paths.creepRadius[index] > 0) {
      extent.smallestRadius = Math.min(extent.smallestRadius, paths.creepRadius[index]);
      extent.largestRadius = Math.max(extent.largestRadius, paths.creepRadius[index]);
    }
    extent.highest = Math.max(extent.highest, paths.height[index]);
  }
  return extents;
}

export function pathRange(paths, fromSeconds, toSeconds) {
  const chosen = [];
  for (let index = 0; index < paths.count; index += 1) {
    if (paths.seconds[index] >= fromSeconds && paths.seconds[index] < toSeconds) chosen.push(index);
  }
  const range = pathTable(chosen.length);
  for (const key of Object.keys(PATH_ARRAYS)) {
    const width = PATH_WIDTHS[key] ?? 1;
    const from = paths[key];
    const to = range[key];
    chosen.forEach((index, position) => {
      for (let part = 0; part < width; part += 1) to[position * width + part] = from[index * width + part];
    });
  }
  range.origin = Uint32Array.from(chosen, index => (paths.origin ? paths.origin[index] : index));
  range.count = chosen.length;
  range.cells = paths.cells;
  return range;
}

function framePlan(prepared, group, extent, paths, sampleRate, profile, scene, receiverZ) {
  const speed = profile.groundSpeed;
  const { longestSpan, largestCreep, smallestRadius, largestRadius } = extent;
  const highest = Math.max(receiverZ, extent.highest);
  let longestElement = 0;
  for (const table of [prepared.sources, paths.cells[Math.floor(group / FRAME_GROUPS)]].filter(Boolean)) {
    for (let index = 0; index < table.length; index += 1) longestElement = Math.max(longestElement, table.elementMetres[index]);
  }
  const preRoll = PRE_ROLL_SAMPLES + Math.ceil(longestElement / speed * sampleRate / 2);
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
    smoothing[bin] = riseSmoothing(frequency, prepared.emitter.riseTimeSeconds / (prepared.flights ? FLIGHT.turbulentFront.riseRatio : 1));
    if (smoothingLimit === bins && smoothing[bin] < NEGLIGIBLE_SMOOTHING) smoothingLimit = bin;
    gridPosition[bin] = bin === 0 ? 0 : Math.min(GROUND_GRID_POINTS - 1.000001, Math.log(frequency / lowest) / ratio * (GROUND_GRID_POINTS - 1));
  }
  const foliage = scene.ground.forest ? { loss: new Float64Array(bins), lag: new Float64Array(bins) } : null;
  if (foliage) for (let bin = 1; bin < bins; bin += 1) [foliage.loss[bin], foliage.lag[bin]] = foliageExponent(bin * sampleRate / size);
  const groundFrequencies = Float64Array.from({ length: GROUND_GRID_POINTS }, (_, index) => lowest * Math.exp(ratio * index / (GROUND_GRID_POINTS - 1)));
  if (foliage) foliage.grid = Array.from(groundFrequencies, foliageExponent);
  const layered = scene.air.absorption && scene.air.refraction ? layeredAbsorption(scene.air, lowest, sampleRate / 2, bins, sampleRate / size, highest) : null;
  const shadowFloor = 10 ** (-scene.air.shadowFloorDecibels / 20);
  const shadow = largestCreep > 0 ? { loss: new Float64Array(bins), lag: new Float64Array(bins) } : null;
  if (shadow) {
    for (let bin = 1; bin < bins; bin += 1) [shadow.loss[bin], shadow.lag[bin]] = shadowExponent(bin * sampleRate / size);
    if (soft) shadow.ground = groundCreeping(scene.ground.type, speed, smallestRadius, largestRadius);
  }
  return { preRoll, hop, size, bins, absorption, layered, foliage, shadow, shadowFloor, smoothing, smoothingLimit, gridPosition, groundFrequencies, binHz: sampleRate / size, riseSeconds: prepared.emitter.riseTimeSeconds, cutoff: cutoffNepers(scene) };
}

/** Class B per layer: ISO 9613-1. */
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

function binAbsorption(plan, bin) {
  if (!plan.layered) return plan.absorption[bin];
  const { position, path } = plan.layered;
  const at = position[bin];
  const lower = Math.floor(at);
  return path[lower] + (path[lower + 1] - path[lower]) * (at - lower);
}

function groundCreeping(groundType, speed, smallest, largest) {
  const rows = largest > smallest * 1.0001 ? CREEPING_RADII : 1;
  const radii = Float64Array.from({ length: rows }, (_, row) => (rows > 1 ? smallest * (largest / smallest) ** (row / (rows - 1)) : smallest));
  const transitions = Float64Array.from(radii, radius => creepingTransitionHz(GROUND.flowResistivity[groundType], speed, radius));
  return { radii, transitions };
}

function pathTransitionHz(ground, radius) {
  const { radii, transitions } = ground;
  if (radii.length === 1) return transitions[0];
  let row = 0;
  while (row < radii.length - 2 && radius > radii[row + 1]) row += 1;
  const mix = Math.min(1, Math.max(0, Math.log(radius / radii[row]) / Math.log(radii[row + 1] / radii[row])));
  return transitions[row] * (transitions[row + 1] / transitions[row]) ** mix;
}

function linearShare(parameter) {
  return smoothStep((parameter - PROPAGATION.mergedParameter) / (PROPAGATION.linearParameter - PROPAGATION.mergedParameter));
}

function smoothStep(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function absorptionLimit(plan, metres) {
  let low = 0;
  let high = plan.smoothingLimit;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (binAbsorption(plan, middle) * metres > plan.cutoff) high = middle; else low = middle + 1;
  }
  return low;
}

/** Class B: the causal creeping response; its regularization and the shadow floor's join class C. */
export function shadowResponse(frequencyHz, nepersAtOneHertz, floor, transitionHz = 0) {
  const [loss, lag] = shadowExponent(frequencyHz);
  if (!transitionHz) return shadowFromExponent(loss, lag, creepingBeta(nepersAtOneHertz), floor);
  const [softLoss, softLag] = softExponent(frequencyHz, transitionHz);
  return shadowFromExponent(loss + softLoss, lag + softLag, creepingBeta(nepersAtOneHertz), floor);
}

const creepingBeta = nepersAtOneHertz => 2 * nepersAtOneHertz / (Math.sqrt(3) * Math.cbrt(2 * Math.PI));

const shadowExponent = frequencyHz => cubeRootExponent(frequencyHz, PROPAGATION.shadowRegularizationHz);

function shadowFromExponent(loss, lag, beta, floor) {
  const magnitude = (1 - floor) * Math.exp(-beta * loss);
  const phase = -beta * lag;
  return [magnitude * Math.cos(phase) + floor, magnitude * Math.sin(phase)];
}

function accumulatePath(spectra, gains, plan, sources, sourceIndex, paths, index, offsetSamples, scene, speed, groundRe, groundIm, ends, seed, receiverHeight, receiverZ, shared = null) {
  const channels = spectra.length;
  const metres = paths.metres[index];
  if (plan.layered) pathAbsorption(plan.layered, paths.height[index], receiverZ);
  const { absorption, layered, foliage, smoothing, gridPosition, binHz, size } = plan;
  // Class C.
  const underCanopy = foliage ? Math.min(paths.foliageMetres[index], GROUND.maximumFoliageMetres) * scene.ground.forestDensity : 0;
  const coarseForest = underCanopy > 0 && scene.render.quality.coarseForest;
  if (coarseForest) {
    for (let point = 0; point < GROUND_GRID_POINTS; point += 1) {
      const [loss, lag] = foliage.grid[point];
      const magnitude = Math.exp(-loss * underCanopy);
      forestRe[point] = magnitude * Math.cos(-lag * underCanopy);
      forestIm[point] = magnitude * Math.sin(-lag * underCanopy);
    }
  }
  const finestForest = underCanopy > 0 && !coarseForest;
  const gain = sources.amplitudePaMetres[sourceIndex] * paths.amplitudeScale[index] / Math.max(paths.spreadMetres[index], Number.MIN_VALUE);
  if (!(gain > 0)) return;
  const mach = gain / (GAMMA_AIR * scene.air.pressureKpa * 1000);
  // Steepening undoes absorption beyond the steady shock's own rise.
  const riseSeconds = PROPAGATION.shockRisePascalSeconds / gain;
  const pulseKind = sources.pulse[sourceIndex];
  const shock = pulseKind === PULSE_NOISE || paths.aloft[index] ? 0 : smoothStep((paths.duration[index] / riseSeconds - PROPAGATION.oldAgeDurationRatio) / (PROPAGATION.shockDurationRatio - PROPAGATION.oldAgeDurationRatio));
  const shockSigma = riseSeconds / RISE_TIME_PER_SIGMA;
  const pathLoss = (bin, linear) => (shock > 0 ? linear - shock * Math.max(0, linear - 2 * (Math.PI * shockSigma * bin * binHz) ** 2) : linear);
  const shockLimit = shock > 0 ? Math.ceil(Math.sqrt(plan.cutoff / 2) / (Math.PI * shockSigma * binHz)) : 0;
  const absorbingMetres = metres * (1 + paths.absorptionExcess[index]);
  const { highestFrequencyHz } = scene.render.quality;
  const limit = Math.min(plan.smoothingLimit, Math.max(absorptionLimit(plan, absorbingMetres), shockLimit), highestFrequencyHz < scene.render.sampleRate / 2 ? Math.ceil(highestFrequencyHz / binHz) : Infinity);
  if (limit < 2) return;
  const creepNepers = paths.creepNepers[index];
  const { shadow, shadowFloor } = plan;
  const beta = creepNepers > 0 ? creepingBeta(creepNepers) : 0;
  const transitionHz = creepNepers > 0 && shadow.ground ? pathTransitionHz(shadow.ground, paths.creepRadius[index]) : 0;
  const edgeCount = paths.edgeCount[index];
  const edges = Array.from({ length: edgeCount }, (_, edge) => pathEdge(paths, index, edge));
  const kind = paths.kind[index];
  const reflected = kind === PATH_GROUND;
  const ground = (reflected || isEcho(kind)) && !isReflecting(scene.ground.type);
  const turbulent = reflected && scene.air.turbulenceStrength > 0;
  const merging = reflected ? 1 - shock * (1 - linearShare(paths.cosIncidence[index] / Math.sqrt(2 * AIR_NONLINEARITY * mach))) : 1;
  let scattering = false;
  if (ground || turbulent) {
    const roughness = reflected && ground ? GROUND.roughnessMetres : 0;
    for (let point = 0; point < GROUND_GRID_POINTS; point += 1) {
      const frequency = plan.groundFrequencies[point];
      let q = !ground ? [1, 0]
        : kind === PATH_SCATTER ? [planeReflectionMagnitude(frequency, scene.ground.type, paths.cosIncidence[index]), 0]
          : sphericalReflectionCoefficient(frequency, scene.ground.type, paths.cosIncidence[index], metres, speed);
      const k = 2 * Math.PI * frequency / speed;
      const variance = (2 * k * roughness * paths.cosIncidence[index]) ** 2
        + (turbulent ? turbulentPhaseVariance(frequency, metres, paths.height[index], receiverHeight, scene.air, speed) : 0);
      const coherent = reflected ? Math.exp(-variance / 2) : 1;
      groundScatter[point] = reflected ? merging * Math.hypot(q[0], q[1]) * Math.sqrt(1 - coherent * coherent) : 0;
      if (groundScatter[point] > 0) scattering = true;
      q = [merging * coherent * q[0] + 1 - merging, merging * coherent * q[1]];
      // Class C.
      for (let bounce = 1, single = q; bounce < paths.bounces[index]; bounce += 1) q = [q[0] * single[0] - q[1] * single[1], q[0] * single[1] + q[1] * single[0]];
      groundRe[point] = q[0];
      groundIm[point] = q[1];
    }
  }
  const key = paths.origin ? paths.origin[index] : index;
  const reflectionScatter = scattering ? subArrivals(GROUND.scatterArrivals, GROUND.scatterSeconds, seed ^ Math.imul(key + 1, 0x165667b1), binHz) : null;
  const endCount = isEcho(kind) ? echoEnds(ends, plan, scene, sources, sourceIndex, paths, index, metres, speed) : 0;
  const spreadSeed = seed ^ Math.imul(key + 1, 0x85ebca6b);
  const group = paths.timeSpread[index] > 0 && shared ? shared.group(paths.timeSpread[index], spreadSeed, plan, limit) : null;
  if (group) spectra = group.spectra;
  const spreadArrivals = paths.timeSpread[index] > 0 && !group ? scatterArrivals(paths.timeSpread[index], spreadSeed, binHz, scene.render.quality.scatterArrivals) : null;
  const turbulence = sources.flight[sourceIndex] ? turbulentFront(plan.riseSeconds, FLIGHT.turbulentFront.frontShare * Math.sqrt(scene.air.turbulenceStrength / FLIGHT.turbulentFront.referenceTurbulence), isEcho(kind) ? seed ^ Math.imul(key + 1, 0x27d4eb2f) : seed, binHz) : null;
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
  const triple = pulseKind === PULSE_TRIPLE;
  const nWave = pulseKind === PULSE_NWAVE || triple;
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
    let factor = gain * smoothing[bin] * Math.exp(-pathLoss(bin, (layered ? binAbsorption(plan, bin) : absorption[bin]) * absorbingMetres) - (finestForest ? foliage.loss[bin] * underCanopy : 0));
    if (directive) {
      factor *= directivityIm / (directivityStep * bin);
      const nextRe = directivityRe * directivityStepRe - directivityIm * directivityStepIm;
      directivityIm = directivityRe * directivityStepIm + directivityIm * directivityStepRe;
      directivityRe = nextRe;
    }
    re *= factor;
    im *= factor;
    if (coarseForest) {
      const position = gridPosition[bin];
      const lower = Math.floor(position);
      const mix = position - lower;
      const fRe = forestRe[lower] + (forestRe[lower + 1] - forestRe[lower]) * mix;
      const fIm = forestIm[lower] + (forestIm[lower + 1] - forestIm[lower]) * mix;
      const nextRe = re * fRe - im * fIm;
      im = re * fIm + im * fRe;
      re = nextRe;
    } else if (underCanopy) {
      const phase = -foliage.lag[bin] * underCanopy;
      const cos = Math.cos(phase);
      const sin = Math.sin(phase);
      const nextRe = re * cos - im * sin;
      im = re * sin + im * cos;
      re = nextRe;
    }
    for (let edge = 0; edge < edgeCount; edge += 1) {
      const [eRe, eIm] = edgeField(edges[edge], bin * binHz);
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

function sharedScatter(channels, count, salt) {
  const pool = new Map();
  let frameSeed = 0;
  const used = new Set();
  return {
    start(group, frame) {
      frameSeed = (Math.imul(group + 1, 0x9e3779b9) ^ Math.imul(frame + 1, 0x85ebca6b) ^ salt) >>> 0;
      used.clear();
    },
    group(spread, seed, plan, limit) {
      const perOctave = PROPAGATION.sharedClassesPerOctave;
      const spreadClass = Math.max(0, Math.round(Math.log2(spread / PROPAGATION.scatterBinSeconds) * perOctave));
      const key = `${plan.size}:${spreadClass}:${(seed >>> 0) % PROPAGATION.sharedVariants}`;
      let entry = pool.get(key);
      if (!entry) {
        entry = {
          spectra: Array.from({ length: channels }, () => ({ real: new Float64Array(plan.size), imaginary: new Float64Array(plan.size) })),
          spread: PROPAGATION.scatterBinSeconds * 2 ** (spreadClass / perOctave), variant: (seed >>> 0) % PROPAGATION.sharedVariants, plan, limit: 0
        };
        pool.set(key, entry);
      }
      entry.limit = Math.max(entry.limit, limit);
      used.add(entry);
      return entry;
    },
    finish(spectra) {
      for (const entry of used) {
        const { gain, re, im, stepRe, stepIm } = scatterArrivals(entry.spread, (frameSeed ^ Math.imul(entry.variant + 1, 0x27d4eb2f) ^ Math.imul(Math.round(entry.spread * 1e4), 0x165667b1)) >>> 0, entry.plan.binHz, count);
        for (let bin = 1; bin < entry.limit; bin += 1) {
          let sumRe = 0;
          let sumIm = 0;
          for (let k = 0; k < gain.length; k += 1) {
            sumRe += gain[k] * re[k];
            sumIm += gain[k] * im[k];
            const nextRe = re[k] * stepRe[k] - im[k] * stepIm[k];
            im[k] = re[k] * stepIm[k] + im[k] * stepRe[k];
            re[k] = nextRe;
          }
          for (let channel = 0; channel < channels; channel += 1) {
            const source = entry.spectra[channel];
            const aRe = source.real[bin];
            const aIm = source.imaginary[bin];
            spectra[channel].real[bin] += aRe * sumRe - aIm * sumIm;
            spectra[channel].imaginary[bin] += aRe * sumIm + aIm * sumRe;
            source.real[bin] = 0;
            source.imaginary[bin] = 0;
          }
        }
        entry.limit = 0;
      }
    }
  };
}

function scatterArrivals(spread, seed, binHz, count) {
  const random = createRandom(seed >>> 0);
  const gain = new Float64Array(count);
  const delays = new Float64Array(count);
  for (let k = 0; k < count; k += 1) {
    delays[k] = random() * spread - PROPAGATION.scatterBinSeconds / 2;
    gain[k] = (random() < .5 ? -1 : 1) / Math.sqrt(count);
  }
  return rotations(gain, delays, binHz, 0);
}

function rotations(gain, delays, binHz, direct, scale = 1) {
  const count = gain.length;
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  const stepRe = new Float64Array(count);
  const stepIm = new Float64Array(count);
  for (let k = 0; k < count; k += 1) {
    const step = -2 * Math.PI * binHz * delays[k] * scale;
    stepRe[k] = Math.cos(step); stepIm[k] = Math.sin(step);
    re[k] = stepRe[k]; im[k] = stepIm[k];
  }
  return { gain, re, im, stepRe, stepIm, direct };
}

function subArrivals(count, seconds, seed, binHz) {
  const random = createRandom(seed >>> 0);
  const gain = new Float64Array(count);
  const delays = new Float64Array(count);
  for (let k = 0; k < count; k += 1) {
    gain[k] = (random() < .5 ? -1 : 1) / Math.sqrt(count);
    delays[k] = Math.min(FLIGHT.turbulentFront.longestRises, -Math.log(1 - random()));
  }
  return rotations(gain, delays, binHz, 0, seconds);
}

function turbulentFront(riseSeconds, share, seed, binHz) {
  const random = createRandom((seed ^ 0x5bd1e995) >>> 0);
  const gain = Float64Array.from({ length: FLIGHT.turbulentFront.arrivals }, () => normalDeviate(random));
  const mean = gain.reduce((sum, value) => sum + value, 0) / FLIGHT.turbulentFront.arrivals;
  const spread = Math.sqrt(gain.reduce((sum, value) => sum + (value - mean) ** 2, 0) / FLIGHT.turbulentFront.arrivals) || 1;
  const delays = new Float64Array(FLIGHT.turbulentFront.arrivals);
  for (let k = 0; k < FLIGHT.turbulentFront.arrivals; k += 1) {
    gain[k] = (gain[k] - mean) / spread * share / Math.sqrt(FLIGHT.turbulentFront.arrivals);
    delays[k] = Math.min(FLIGHT.turbulentFront.longestRises, -Math.log(1 - random()));
  }
  return rotations(gain, delays, binHz, 1, riseSeconds);
}

/** Class C. */
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
    const step = -2 * Math.PI * plan.binHz * lift / speed;
    end.rotation = { re: Math.cos(step), im: Math.sin(step), stepRe: Math.cos(step), stepIm: Math.sin(step) };
    count += 1;
  }
  return count;
}

function synthesizeFramePair(first, second, size, sampleRate) {
  const { real, imaginary } = first;
  for (let bin = 1; bin < size / 2; bin += 1) {
    const aRe = real[bin]; const aIm = imaginary[bin];
    const bRe = second.real[bin]; const bIm = second.imaginary[bin];
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

export function renderReceiverRange(preparedEmitters, receiver, scene, { fromSeconds = -Infinity, toSeconds = Infinity, onProgress = null, paths: traced = null, extents = null } = {}) {
  const sampleRate = scene.render.sampleRate;
  const profile = soundSpeedProfile(scene.air);
  const speed = profile.groundSpeed;
  const traceShare = traced ? 0 : TRACE_SHARE;
  const paths = traced ?? receiverPaths(preparedEmitters, receiver, scene, { onProgress: onProgress && (share => onProgress(TRACE_SHARE * share)) });
  const receiverZ = onGround(terrainSurface(scene.terrain), receiver.positionMetres).z;
  const extentOf = extents ?? frameExtents(preparedEmitters, paths);
  const plans = preparedEmitters.flatMap((prepared, emitterIndex) => Array.from({ length: FRAME_GROUPS }, (_, part) => {
    const group = FRAME_GROUPS * emitterIndex + part;
    return framePlan(prepared, group, extentOf[group], paths, sampleRate, profile, scene, receiverZ);
  }));
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
  // Class C: the roar comes from the whole fireball and debris, so its reflection does not interfere with it.
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
  const shared = scene.render.quality.sharedScatter ? sharedScatter(channels, scene.render.quality.scatterArrivals, forestSeed(receiver.id)) : null;
  const weightOf = index => RENDER.progressWeights[frameGroup(paths, index) % FRAME_GROUPS];
  const totalWeight = selected.reduce((sum, index) => sum + weightOf(index), 0);
  let doneWeight = 0;
  let cursor = 0;
  while (cursor < selected.length) {
    const group = frameGroup(paths, selected[cursor]);
    const emitterIndex = paths.emitter[selected[cursor]];
    const frame = frameOf[selected[cursor]];
    const plan = plans[group];
    const spectra = Array.from({ length: channels }, () => ({ real: new Float64Array(plan.size), imaginary: new Float64Array(plan.size) }));
    shared?.start(group, frame);
    while (cursor < selected.length && frameGroup(paths, selected[cursor]) === group && frameOf[selected[cursor]] === frame) {
      const index = selected[cursor];
      const sources = pathSources(preparedEmitters, paths, index);
      const seed = (Math.imul(preparedEmitters[emitterIndex].emitter.seed ^ 0x9e3779b9, 31) + paths.source[index]) >>> 0;
      encodeDirection(paths.direction[3 * index], paths.direction[3 * index + 1], paths.direction[3 * index + 2], order, gains);
      accumulatePath(spectra, gains, plan, sources, paths.source[index], paths, index, paths.seconds[index] * sampleRate - frame * plan.hop, scene, speed, groundRe, groundIm, ends, seed, receiver.positionMetres.z, receiverZ, shared);
      doneWeight += weightOf(index);
      cursor += 1;
    }
    shared?.finish(spectra);
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
    onProgress?.(traceShare + (1 - traceShare) * doneWeight / totalWeight);
  }
  for (const roar of roars) {
    for (const { samples, impulses } of roar ?? []) {
      if (impulses) convolveAdd(outputs, impulses, samples);
    }
  }
  return { startSample: first, channels: outputs, nonlinearPaths, pathCount: selected.length };
}

export function hasTails(scene) {
  return scene.ground.forest || surroundingsTail(scene);
}

const surroundingsTail = scene => scene.ground.surroundings && !(echoesActive(scene) && !terrainSurface(scene.terrain).flat);

export function tailResponses(receiver, scene, channels = [0, channelCount(scene.render.ambisonicOrder)]) {
  if (!hasTails(scene)) return null;
  const count = channelCount(scene.render.ambisonicOrder);
  const { sampleRate } = scene.render;
  return {
    forest: scene.ground.forest ? forestResponses(forestSeed(receiver.id), count, sampleRate, channels, scene.ground.forestDensity) : null,
    surroundings: surroundingsTail(scene) ? surroundingsResponses(forestSeed(receiver.id), count, sampleRate, channels) : null
  };
}

export function joinResponses(shares) {
  const join = kind => (shares[0][kind] ? shares.flatMap(share => share[kind]) : null);
  return { forest: join('forest'), surroundings: join('surroundings') };
}

export const tailSamples = responses => (responses?.forest?.[0].length ?? 0) + (responses?.surroundings?.[0].length ?? 0);

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

export function tailStretches(length, count, shortest = 1) {
  const parts = Math.max(1, Math.min(count, Math.floor(length / Math.max(1, shortest))));
  return Array.from({ length: parts }, (_, part) => [Math.floor(part * length / parts), Math.floor((part + 1) * length / parts)]);
}

export function addTails(sum, from, tails) {
  tails.forEach((tail, channel) => {
    const target = sum.channels[channel];
    for (let index = 0; index < tail.length; index += 1) target[from + index] += tail[index];
  });
}

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

export function combineSegments(segments, sampleRate) {
  return finishSum(sumSegments(segments, sampleRate), sampleRate);
}

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

export function receiverResult(receiver, scene, combined, arrivals, nonlinearPaths) {
  return {
    receiverId: receiver.id,
    sampleRate: scene.render.sampleRate,
    ...combined,
    samples: combined.channels[0],
    speedOfSound: soundSpeedProfile(scene.air).groundSpeed,
    arrivals,
    nonlinearPaths,
    modelVersion: MODEL_VERSION
  };
}

export function resultDifference(minuend, subtrahend) {
  const { sampleRate } = minuend;
  const start = Math.min(minuend.startSeconds, subtrahend.startSeconds);
  const offset = result => Math.round((result.startSeconds - start) * sampleRate);
  const length = Math.max(...[minuend, subtrahend].map(result => offset(result) + result.channels[0].length));
  let peakPa = 0;
  const channels = minuend.channels.map((_, channel) => {
    const out = new Float32Array(length);
    out.set(minuend.channels[channel], offset(minuend));
    const from = offset(subtrahend);
    subtrahend.channels[channel].forEach((value, index) => { out[from + index] -= value; });
    if (channel === 0) out.forEach(value => { peakPa = Math.max(peakPa, Math.abs(value)); });
    return out;
  });
  return { ...minuend, startSeconds: start, channels, samples: channels[0], peakPa };
}

export function echoFreeShare(results) {
  let start = Infinity;
  let end = -Infinity;
  let echoFreeEnd = -Infinity;
  for (const result of results.values()) {
    const { arrivals } = result;
    let last = -Infinity;
    let lastEchoFree = -Infinity;
    for (let index = 0; index < arrivals.count; index += 1) {
      last = Math.max(last, arrivals.seconds[index]);
      if (arrivals.kinds[index] < PATH_ECHO) lastEchoFree = Math.max(lastEchoFree, arrivals.seconds[index]);
    }
    const ends = result.startSeconds + result.samples.length / result.sampleRate;
    start = Math.min(start, result.startSeconds);
    end = Math.max(end, ends);
    echoFreeEnd = Math.max(echoFreeEnd, Number.isFinite(lastEchoFree) ? ends - (last - lastEchoFree) : result.startSeconds);
  }
  return end > start ? Math.min(1, Math.max(0, (echoFreeEnd - start) / (end - start))) : 1;
}

export function renderReceiver(preparedEmitters, receiver, scene) {
  const segment = renderReceiverRange(preparedEmitters, receiver, scene);
  return receiverResult(receiver, scene, combineWithTails([segment], receiver, scene), arrivalTable(preparedEmitters, receiver, scene), segment.nonlinearPaths);
}
