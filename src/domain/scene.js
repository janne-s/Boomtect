import {
  ISA_LAPSE_RATE_KELVIN_PER_METRE, MAXIMUM_EMITTERS, MAXIMUM_HEIGHT_METRES, MAXIMUM_RECEIVERS, MODEL_VERSION, SAMPLE_RATE_HZ, SCENE_EXTENT_METRES
} from './constants.js';
import { EMITTER_KINDS } from './emitters.js';
import { GROUND_TYPES } from './ground.js';
import { FLASH_TYPES } from './lightning.js';
import { isSeed } from './random.js';

export const SCENE_FORMAT = 'boomtect.scene';
export const SCENE_VERSION = 12;
export const RECEIVER_TYPES = Object.freeze(['omni', 'binaural']);
export const MODES = Object.freeze(['thunder', 'blast']);
/** Emitter kinds each mode works with. */
export const MODE_KINDS = Object.freeze({ thunder: Object.freeze(['lightning', 'storm']), blast: Object.freeze(['blast']) });
export const LEVEL_MODES = Object.freeze(['peak', 'fixed']);

/** Minimum depth of a storm's cloud layer. */
export const MINIMUM_CLOUD_DEPTH_METRES = 100;
/** Largest terrain grid side, matching the capture limit in terrain.js. */
const MAXIMUM_TERRAIN_CELLS = 600;
/** Place names kept with a terrain, from OpenStreetMap, and their kinds in drawing priority. */
const MAXIMUM_PLACE_NAMES = 400;
export const PLACE_NAME_KINDS = Object.freeze(['city', 'town', 'village', 'peak', 'water', 'hamlet', 'locality']);

/**
 * Every bounded number in a scene: unit, range, and reliability class of the value it controls.
 * Class A comes from first principles, B from literature, C from heuristic or synthetic choice.
 * A null class marks a placement or output choice rather than a model value.
 */
export const PARAMETERS = Object.freeze({
  temperatureCelsius: { minimum: -40, maximum: 50, unit: '°C', label: 'Temperature', reliability: 'A' },
  relativeHumidityPercent: { minimum: 0, maximum: 100, unit: '%', label: 'Humidity', reliability: 'B' },
  humidityScaleHeightMetres: { minimum: 500, maximum: 10000, unit: 'm', label: 'Vapour height', reliability: 'B' },
  pressureKpa: { minimum: 50, maximum: 110, unit: 'kPa', label: 'Pressure', reliability: 'A' },
  turbulenceStrength: { minimum: 0, maximum: 1e-4, unit: '⟨μ²⟩', label: 'Turbulence', reliability: 'C' },
  turbulenceScaleMetres: { minimum: .1, maximum: 10, unit: 'm', label: 'Turbulence scale', reliability: 'C' },
  lapseRateKelvinPerMetre: { minimum: -.02, maximum: .012, unit: 'K/m', label: 'Lapse rate', reliability: 'B' },
  groundLayerMetres: { minimum: 0, maximum: 2000, unit: 'm', label: 'Ground layer', reliability: 'C' },
  groundLayerLapseKelvinPerMetre: { minimum: -.05, maximum: .012, unit: 'K/m', label: 'Layer lapse', reliability: 'C' },
  tropopauseMetres: { minimum: 5000, maximum: 20000, unit: 'm', label: 'Tropopause', reliability: 'B' },
  shadowFloorDecibels: { minimum: 10, maximum: 60, unit: 'dB', label: 'Shadow floor', reliability: 'C' },
  windSpeedMetresPerSecond: { minimum: 0, maximum: 40, unit: 'm/s', label: 'Wind', reliability: null },
  windFromDegrees: { minimum: 0, maximum: 360, unit: '°', label: 'Wind from', reliability: null },
  windShearPerSecond: { minimum: -.02, maximum: .02, unit: '1/s', label: 'Wind shear', reliability: 'C' },
  latitude: { minimum: -85, maximum: 85, unit: '°', label: 'Latitude', reliability: null },
  longitude: { minimum: -180, maximum: 180, unit: '°', label: 'Longitude', reliability: null },
  terrainExtentMetres: { minimum: 500, maximum: 20000, unit: 'm', label: 'Area', reliability: null },
  terrainCellMetres: { minimum: 5, maximum: 200, unit: 'm', label: 'Resolution', reliability: null },
  scattering: { minimum: 0, maximum: 1, unit: '', label: 'Scattering', reliability: 'C' },
  echoCellMetres: { minimum: 25, maximum: 500, unit: 'm', label: 'Echo cells', reliability: 'C' },
  echoLimit: { minimum: 10, maximum: 2000, unit: '', label: 'Echoes per cell', reliability: 'C', integer: true },
  coordinateMetres: { minimum: -SCENE_EXTENT_METRES, maximum: SCENE_EXTENT_METRES, unit: 'm', reliability: null },
  heightMetres: { minimum: 0, maximum: MAXIMUM_HEIGHT_METRES, unit: 'm', reliability: null },
  startSeconds: { minimum: 0, maximum: 240, unit: 's', label: 'Onset', reliability: null },
  segmentLengthMetres: { minimum: 1, maximum: 100, unit: 'm', label: 'Segment length', reliability: 'C' },
  straightLengthMetres: { minimum: .1, maximum: 100, unit: 'm', label: 'Straight element', reliability: 'C' },
  tortuosityDegrees: { minimum: 0, maximum: 60, unit: '°', label: 'Tortuosity', reliability: 'C' },
  branchCount: { minimum: 0, maximum: 50, unit: '', label: 'Branches', reliability: 'C', integer: true },
  branchLengthRatio: { minimum: .02, maximum: 1, unit: '', label: 'Branch length', reliability: 'C' },
  branchEnergyRatio: { minimum: .01, maximum: 1, unit: '', label: 'Branch energy', reliability: 'C' },
  energyJoulesPerMetre: { minimum: 1e3, maximum: 1e7, unit: 'J/m', label: 'Energy per metre', reliability: 'B' },
  energyVariation: { minimum: 0, maximum: 1.5, unit: '', label: 'Energy variation σ', reliability: 'C' },
  acousticEfficiency: { minimum: 1e-4, maximum: .2, unit: '', label: 'Acoustic efficiency', reliability: 'C' },
  periodCoefficient: { minimum: 1.5, maximum: 5, unit: '', label: 'Period coefficient k', reliability: 'B' },
  weakShockLimitRadii: { minimum: 10, maximum: 1e6, unit: 'R₀', label: 'Weak-shock range', reliability: 'C' },
  macroStepMetres: { minimum: 20, maximum: 2000, unit: 'm', label: 'Zigzag step', reliability: 'C' },
  macroTortuosityDegrees: { minimum: 0, maximum: 60, unit: '°', label: 'Zigzag angle', reliability: 'C' },
  branchDepth: { minimum: 0, maximum: 3, unit: '', label: 'Branch levels', reliability: 'C', integer: true },
  newTerminationProbability: { minimum: 0, maximum: 1, unit: '', label: 'New ground point', reliability: 'C' },
  strokeIntervalSpread: { minimum: 0, maximum: 1.5, unit: '', label: 'Interval spread σ', reliability: 'C' },
  channelSpeedMetresPerSecond: { minimum: 1e4, maximum: 3e8, unit: 'm/s', label: 'Channel speed', reliability: 'B' },
  strokeCount: { minimum: 1, maximum: 20, unit: '', label: 'Strokes', reliability: 'B', integer: true },
  strokeIntervalSeconds: { minimum: .005, maximum: .5, unit: 's', label: 'Stroke interval', reliability: 'B' },
  subsequentStrokeEnergyRatio: { minimum: .05, maximum: 1, unit: '', label: 'Later stroke energy', reliability: 'C' },
  radiusMetres: { minimum: 0, maximum: 30000, unit: 'm', label: 'Radius', reliability: null },
  durationSeconds: { minimum: 0, maximum: 120, unit: 's', label: 'Duration', reliability: null },
  flashCount: { minimum: 1, maximum: 60, unit: '', label: 'Flashes', reliability: null, integer: true },
  groundFlashShare: { minimum: 0, maximum: 1, unit: '', label: 'Ground flashes', reliability: 'B' },
  cloudBaseMetres: { minimum: 200, maximum: 8000, unit: 'm', label: 'Cloud base', reliability: null },
  cloudTopMetres: { minimum: 1000, maximum: 18000, unit: 'm', label: 'Cloud top', reliability: null },
  energySpread: { minimum: 0, maximum: 1.5, unit: '', label: 'Flash energy spread σ', reliability: 'C' },
  currentDecayHeightMetres: { minimum: 300, maximum: 1e6, unit: 'm', label: 'Current decay height', reliability: 'B' },
  inCloudLengthMetres: { minimum: 0, maximum: 20000, unit: 'm', label: 'In-cloud channels', reliability: 'C' },
  inCloudEnergyRatio: { minimum: .01, maximum: 1, unit: '', label: 'In-cloud energy', reliability: 'C' },
  inCloudSpeedMetresPerSecond: { minimum: 1e4, maximum: 1e7, unit: 'm/s', label: 'In-cloud speed', reliability: 'B' },
  chargeKilograms: { minimum: .001, maximum: 1e6, unit: 'kg TNT', label: 'Charge', reliability: 'B' },
  linearScaledDistance: { minimum: 5, maximum: 100, unit: 'm/kg^⅓', label: 'Linearization distance', reliability: 'C' },
  durationSecondsPerCubeRootKilogram: { minimum: 1e-4, maximum: .05, unit: 's/kg^⅓', label: 'Positive phase', reliability: 'C' },
  decay: { minimum: .1, maximum: 5, unit: '', label: 'Decay b', reliability: 'C' },
  riseTimeSeconds: { minimum: 5e-6, maximum: 1e-3, unit: 's', label: 'Rise time', reliability: 'C' },
  fullScalePa: { minimum: .01, maximum: 1e5, unit: 'Pa', label: 'Full scale', reliability: null },
  ambisonicOrder: { minimum: 0, maximum: 3, unit: '', label: 'Ambisonic order', reliability: null, integer: true },
  headingDegrees: { minimum: 0, maximum: 360, unit: '°', label: 'Facing', reliability: null },
  pitchDegrees: { minimum: -90, maximum: 90, unit: '°', label: 'Elevation', reliability: null }
});

const CHANNEL_NUMBERS = Object.freeze([
  'segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'macroStepMetres', 'macroTortuosityDegrees',
  'branchCount', 'branchDepth', 'branchEnergyRatio', 'energyJoulesPerMetre', 'energyVariation', 'acousticEfficiency',
  'periodCoefficient', 'weakShockLimitRadii', 'riseTimeSeconds'
]);
/** A ground flash's return-stroke current decay and in-cloud channels; storms share them. */
const GROUND_FLASH_NUMBERS = Object.freeze(['currentDecayHeightMetres', 'inCloudLengthMetres', 'inCloudEnergyRatio', 'inCloudSpeedMetresPerSecond']);
const LIGHTNING_NUMBERS = Object.freeze([
  'startSeconds', ...CHANNEL_NUMBERS, 'branchLengthRatio', 'channelSpeedMetresPerSecond', 'strokeCount', 'strokeIntervalSeconds',
  'strokeIntervalSpread', 'subsequentStrokeEnergyRatio', 'newTerminationProbability', ...GROUND_FLASH_NUMBERS
]);
const STORM_NUMBERS = Object.freeze([
  'startSeconds', 'radiusMetres', 'durationSeconds', 'flashCount', 'groundFlashShare', 'cloudBaseMetres', 'cloudTopMetres',
  'energySpread', 'newTerminationProbability', ...CHANNEL_NUMBERS, ...GROUND_FLASH_NUMBERS
]);
const BLAST_NUMBERS = Object.freeze(['startSeconds', 'chargeKilograms', 'linearScaledDistance', 'durationSecondsPerCubeRootKilogram', 'decay', 'riseTimeSeconds']);

export class SceneError extends Error {}

const LIGHTNING_PHYSICS = Object.freeze({
  segmentLengthMetres: 10,
  straightLengthMetres: .5,
  tortuosityDegrees: 16,
  macroStepMetres: 150,
  macroTortuosityDegrees: 30,
  energyVariation: .5,
  acousticEfficiency: .01,
  periodCoefficient: 2.81,
  weakShockLimitRadii: 1e4,
  riseTimeSeconds: 4e-5,
  currentDecayHeightMetres: 2000,
  inCloudLengthMetres: 5000,
  inCloudEnergyRatio: .3,
  inCloudSpeedMetresPerSecond: 3e5
});

export function defaultLightning(id = 'lightning-1', name = 'Ground flash', seed = 20261009) {
  return {
    id, name, kind: 'lightning', enabled: true, seed,
    startSeconds: 0,
    flashType: 'cloud-to-ground',
    baseMetres: { x: 0, y: 0, z: 0 },
    topMetres: { x: 600, y: 0, z: 4000 },
    ...LIGHTNING_PHYSICS,
    branchCount: 10,
    branchDepth: 2,
    branchLengthRatio: .35,
    branchEnergyRatio: .2,
    energyJoulesPerMetre: 1e5,
    channelSpeedMetresPerSecond: 1e8,
    strokeCount: 4,
    strokeIntervalSeconds: .06,
    strokeIntervalSpread: .5,
    subsequentStrokeEnergyRatio: .5,
    newTerminationProbability: .3
  };
}

export function defaultCloudFlash(id = 'cloud-1', name = 'Cloud flash', seed = 20261010) {
  return {
    ...defaultLightning(id, name, seed),
    flashType: 'intra-cloud',
    baseMetres: { x: -2500, y: 0, z: 5000 },
    topMetres: { x: 2500, y: 1000, z: 6000 },
    branchCount: 12,
    branchLengthRatio: .25,
    energyJoulesPerMetre: 3e4,
    channelSpeedMetresPerSecond: 3e5,
    strokeCount: 4,
    strokeIntervalSeconds: .04,
    subsequentStrokeEnergyRatio: .6,
    newTerminationProbability: 0
  };
}

export function defaultStorm(id = 'storm-1', name = 'Storm', seed = 20261011) {
  return {
    id, name, kind: 'storm', enabled: true, seed,
    startSeconds: 0,
    centreMetres: { x: 0, y: 0, z: 0 },
    radiusMetres: 8000,
    durationSeconds: 60,
    flashCount: 12,
    groundFlashShare: .3,
    cloudBaseMetres: 1500,
    cloudTopMetres: 10000,
    energyJoulesPerMetre: 1e5,
    energySpread: .5,
    newTerminationProbability: .3,
    ...LIGHTNING_PHYSICS,
    branchCount: 8,
    branchDepth: 2,
    branchEnergyRatio: .2
  };
}

export function defaultBlast(id = 'blast-1', name = 'Blast', seed = 20261009) {
  return {
    id, name, kind: 'blast', enabled: true, seed,
    startSeconds: 0,
    positionMetres: { x: 0, y: 0, z: 1 },
    chargeKilograms: 10,
    linearScaledDistance: 20,
    durationSecondsPerCubeRootKilogram: .006,
    decay: 1,
    riseTimeSeconds: 4e-5
  };
}

/** The terrain switches and echo settings a new capture starts with. */
export const TERRAIN_DEFAULTS = Object.freeze({ enabled: true, shielding: true, echoes: true, scattering: .5, echoCellMetres: 100, echoLimit: 500 });

export function defaultReceiver(id = 'receiver-1', name = 'Mic 1', { type = 'omni', listen = true } = {}) {
  return { id, name, type, listen, positionMetres: { x: 2000, y: 0, z: 1.7 }, headingDegrees: 270, pitchDegrees: 0 };
}

export function defaultScene(mode = 'thunder') {
  const blast = mode === 'blast';
  const receiver = defaultReceiver();
  if (blast) receiver.positionMetres = { x: 400, y: 0, z: 1.7 };
  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    mode,
    modelVersion: MODEL_VERSION,
    air: {
      temperatureCelsius: 15, lapseRateKelvinPerMetre: ISA_LAPSE_RATE_KELVIN_PER_METRE, relativeHumidityPercent: 70, pressureKpa: 101.325,
      refraction: true, shadowFloorDecibels: 25, absorption: true, turbulenceStrength: 1e-6, turbulenceScaleMetres: 1.1,
      windSpeedMetresPerSecond: 0, windFromDegrees: 270, windShearPerSecond: 0, humidityScaleHeightMetres: 2000,
      groundLayerMetres: 0, groundLayerLapseKelvinPerMetre: -.02, tropopauseMetres: 11000
    },
    ground: { enabled: true, type: 'grass' },
    terrain: null,
    emitters: [blast ? defaultBlast() : defaultLightning()],
    receivers: [receiver],
    render: { sampleRate: SAMPLE_RATE_HZ, levelMode: 'peak', fullScalePa: 20, ambisonicOrder: 1, earReflex: false, earLoudness: false }
  };
}

function check(condition, message) {
  if (!condition) throw new SceneError(message);
}

function number(value, key, path) {
  const range = PARAMETERS[key];
  check(typeof value === 'number' && Number.isFinite(value), `${path} must be a number.`);
  check(value >= range.minimum && value <= range.maximum, `${path} must be between ${range.minimum} and ${range.maximum} ${range.unit}.`);
  if (range.integer) check(Number.isInteger(value), `${path} must be a whole number.`);
  return value;
}

function point(value, path) {
  check(value && typeof value === 'object', `${path} is missing.`);
  return {
    x: number(value.x, 'coordinateMetres', `${path}.x`),
    y: number(value.y, 'coordinateMetres', `${path}.y`),
    z: number(value.z, 'heightMetres', `${path}.z`)
  };
}

function text(value, path) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 64, `${path} must be a short name.`);
  return value;
}

function numbers(value, keys, path) {
  return Object.fromEntries(keys.map(key => [key, number(value[key], key, `${path}.${key}`)]));
}

function emitter(value, index) {
  const path = `emitters[${index}]`;
  check(value && typeof value === 'object', `${path} is missing.`);
  check(EMITTER_KINDS.includes(value.kind), `${path}.kind is not supported.`);
  check(typeof value.enabled === 'boolean', `${path}.enabled must be true or false.`);
  check(isSeed(value.seed), `${path}.seed must be a 32-bit unsigned integer.`);
  const common = { id: text(value.id, `${path}.id`), name: text(value.name, `${path}.name`), kind: value.kind, enabled: value.enabled, seed: value.seed };
  if (value.kind === 'blast') {
    return { ...common, positionMetres: point(value.positionMetres, `${path}.positionMetres`), ...numbers(value, BLAST_NUMBERS, path) };
  }
  if (value.kind === 'storm') {
    const storm = { ...common, centreMetres: point(value.centreMetres, `${path}.centreMetres`), ...numbers(value, STORM_NUMBERS, path) };
    check(storm.centreMetres.z === 0, `${path}.centreMetres must lie on the ground.`);
    check(storm.cloudTopMetres >= storm.cloudBaseMetres + MINIMUM_CLOUD_DEPTH_METRES, `${path} needs a cloud top above its cloud base.`);
    check(storm.straightLengthMetres <= storm.segmentLengthMetres, `${path}.straightLengthMetres must not exceed the segment length.`);
    return storm;
  }
  check(FLASH_TYPES.includes(value.flashType), `${path}.flashType is not supported.`);
  const lightning = {
    ...common,
    flashType: value.flashType,
    baseMetres: point(value.baseMetres, `${path}.baseMetres`),
    topMetres: point(value.topMetres, `${path}.topMetres`),
    ...numbers(value, LIGHTNING_NUMBERS, path)
  };
  const { baseMetres: base, topMetres: top } = lightning;
  check(lightning.flashType !== 'cloud-to-ground' || base.z === 0, `${path}.baseMetres of a ground flash must lie on the ground.`);
  check(Math.hypot(top.x - base.x, top.y - base.y, top.z - base.z) >= lightning.segmentLengthMetres,
    `${path} must be at least one segment long.`);
  check(lightning.straightLengthMetres <= lightning.segmentLengthMetres, `${path}.straightLengthMetres must not exceed the segment length.`);
  return lightning;
}

/**
 * A captured terrain: where and how it was captured, and its heights as base64 float32 metres
 * above sea level on a square grid, row 0 in the south. Null when the scene has no terrain.
 */
function terrain(value) {
  if (value === null || value === undefined) return null;
  check(typeof value === 'object', 'terrain must be an object or null.');
  check(typeof value.enabled === 'boolean' && typeof value.shielding === 'boolean' && typeof value.echoes === 'boolean', 'terrain.enabled, terrain.shielding, and terrain.echoes must be true or false.');
  check(typeof value.place === 'string' && value.place.length <= 120, 'terrain.place must be a short text.');
  const grid = key => {
    check(Number.isInteger(value[key]) && value[key] >= 2 && value[key] <= MAXIMUM_TERRAIN_CELLS, `terrain.${key} must be a whole number of cells.`);
    return value[key];
  };
  const columns = grid('columns');
  const rows = grid('rows');
  check(Number.isInteger(value.zoom) && value.zoom >= 1 && value.zoom <= 15, 'terrain.zoom must be a tile zoom level.');
  check(typeof value.heights === 'string' && value.heights.length === 4 * Math.ceil(columns * rows * 4 / 3), 'terrain.heights do not match the grid.');
  check(Number.isFinite(value.cellMetres) && value.cellMetres > 0 && Math.abs(value.cellMetres * columns - value.extentMetres) < 1e-6 * value.extentMetres, 'terrain.cellMetres does not match the area.');
  check(Array.isArray(value.names) && value.names.length <= MAXIMUM_PLACE_NAMES, 'terrain.names must be a list of place names.');
  const half = value.extentMetres / 2;
  const names = value.names.map((item, index) => {
    const path = `terrain.names[${index}]`;
    check(item && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 80, `${path}.name must be a short text.`);
    check(PLACE_NAME_KINDS.includes(item.kind), `${path}.kind is not supported.`);
    check([item.x, item.y].every(Number.isFinite) && Math.abs(item.x) <= half && Math.abs(item.y) <= half, `${path} must lie within the terrain.`);
    check(item.elevationMetres === null || Number.isFinite(item.elevationMetres), `${path}.elevationMetres must be a number or null.`);
    return { name: item.name, kind: item.kind, x: item.x, y: item.y, elevationMetres: item.elevationMetres };
  });
  return {
    enabled: value.enabled,
    shielding: value.shielding,
    echoes: value.echoes,
    ...numbers(value, ['scattering', 'echoCellMetres', 'echoLimit'], 'terrain'),
    place: value.place,
    names,
    latitude: number(value.latitude, 'latitude', 'terrain.latitude'),
    longitude: number(value.longitude, 'longitude', 'terrain.longitude'),
    extentMetres: number(value.extentMetres, 'terrainExtentMetres', 'terrain.extentMetres'),
    cellMetres: value.cellMetres,
    zoom: value.zoom,
    columns,
    rows,
    heights: value.heights
  };
}

function receiver(value, index) {
  const path = `receivers[${index}]`;
  check(value && typeof value === 'object', `${path} is missing.`);
  check(RECEIVER_TYPES.includes(value.type), `${path}.type is not supported.`);
  check(typeof value.listen === 'boolean', `${path}.listen must be true or false.`);
  return {
    id: text(value.id, `${path}.id`),
    name: text(value.name, `${path}.name`),
    type: value.type,
    listen: value.listen,
    positionMetres: point(value.positionMetres, `${path}.positionMetres`),
    headingDegrees: number(value.headingDegrees, 'headingDegrees', `${path}.headingDegrees`),
    pitchDegrees: number(value.pitchDegrees, 'pitchDegrees', `${path}.pitchDegrees`)
  };
}

function uniqueIds(items, path) {
  check(new Set(items.map(item => item.id)).size === items.length, `${path} ids must be unique.`);
}

/** Validates a scene document and returns a complete copy, or throws SceneError. */
export function parseScene(value) {
  check(value && typeof value === 'object', 'The scene is not an object.');
  check(value.format === SCENE_FORMAT, 'This is not a Boomtect scene.');
  check(value.version === SCENE_VERSION, `Scene version ${value.version} is not supported.`);
  check(MODES.includes(value.mode), 'The scene mode is not supported.');
  const air = value.air ?? {};
  check(typeof air.absorption === 'boolean', 'air.absorption must be true or false.');
  check(typeof air.refraction === 'boolean', 'air.refraction must be true or false.');
  const ground = value.ground ?? {};
  check(typeof ground.enabled === 'boolean', 'ground.enabled must be true or false.');
  check(GROUND_TYPES.includes(ground.type), 'ground.type is not supported.');
  check(Array.isArray(value.emitters) && value.emitters.length >= 1 && value.emitters.length <= MAXIMUM_EMITTERS,
    `A scene needs 1–${MAXIMUM_EMITTERS} emitters.`);
  check(Array.isArray(value.receivers) && value.receivers.length >= 1 && value.receivers.length <= MAXIMUM_RECEIVERS,
    `A scene needs 1–${MAXIMUM_RECEIVERS} receivers.`);
  const render = value.render ?? {};
  check(render.sampleRate === SAMPLE_RATE_HZ, `render.sampleRate must be ${SAMPLE_RATE_HZ}.`);
  check(LEVEL_MODES.includes(render.levelMode), 'render.levelMode is not supported.');
  check(typeof render.earReflex === 'boolean' && typeof render.earLoudness === 'boolean', 'render.earReflex and render.earLoudness must be true or false.');
  const scene = {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    mode: value.mode,
    modelVersion: MODEL_VERSION,
    air: {
      temperatureCelsius: number(air.temperatureCelsius, 'temperatureCelsius', 'air.temperatureCelsius'),
      lapseRateKelvinPerMetre: number(air.lapseRateKelvinPerMetre, 'lapseRateKelvinPerMetre', 'air.lapseRateKelvinPerMetre'),
      relativeHumidityPercent: number(air.relativeHumidityPercent, 'relativeHumidityPercent', 'air.relativeHumidityPercent'),
      pressureKpa: number(air.pressureKpa, 'pressureKpa', 'air.pressureKpa'),
      refraction: air.refraction,
      shadowFloorDecibels: number(air.shadowFloorDecibels, 'shadowFloorDecibels', 'air.shadowFloorDecibels'),
      absorption: air.absorption,
      turbulenceStrength: number(air.turbulenceStrength, 'turbulenceStrength', 'air.turbulenceStrength'),
      turbulenceScaleMetres: number(air.turbulenceScaleMetres, 'turbulenceScaleMetres', 'air.turbulenceScaleMetres'),
      ...numbers(air, ['windSpeedMetresPerSecond', 'windFromDegrees', 'windShearPerSecond', 'humidityScaleHeightMetres', 'groundLayerMetres', 'groundLayerLapseKelvinPerMetre', 'tropopauseMetres'], 'air')
    },
    ground: { enabled: ground.enabled, type: ground.type },
    terrain: terrain(value.terrain),
    emitters: value.emitters.map(emitter),
    receivers: value.receivers.map(receiver),
    render: {
      sampleRate: render.sampleRate,
      levelMode: render.levelMode,
      fullScalePa: number(render.fullScalePa, 'fullScalePa', 'render.fullScalePa'),
      ambisonicOrder: number(render.ambisonicOrder, 'ambisonicOrder', 'render.ambisonicOrder'),
      earReflex: render.earReflex,
      earLoudness: render.earLoudness
    }
  };
  scene.emitters.forEach((item, index) => check(MODE_KINDS[scene.mode].includes(item.kind), `emitters[${index}] does not belong in ${scene.mode} mode.`));
  uniqueIds(scene.emitters, 'Emitter');
  uniqueIds(scene.receivers, 'Receiver');
  return scene;
}

export const serializeScene = scene => JSON.stringify(parseScene(scene), null, 2);
