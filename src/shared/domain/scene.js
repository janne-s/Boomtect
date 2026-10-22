import { GROUND, ISA_LAPSE_RATE_KELVIN_PER_METRE, PROPAGATION, RENDER, SAMPLE_RATE_HZ } from './constants.js';
import { MAXIMUM_AMBISONIC_ORDER } from './ambisonics.js';
import { GROUND_TYPES } from './ground.js';
import { isSeed } from './random.js';
import { patchCount, rangeBounds, terrainRange } from './terrain.js';

export const DEFAULT_QUALITY = Object.freeze({
  cutoffDecibels: -14 * 20 / Math.LN10,
  highestFrequencyHz: SAMPLE_RATE_HZ / 2,
  sourceMerge: 1,
  echoCellScale: 1,
  scatterArrivals: PROPAGATION.scatterArrivals,
  coarseForest: false,
  sharedScatter: false
});
export const QUALITY_NUMBERS = Object.freeze(Object.keys(DEFAULT_QUALITY).filter(key => typeof DEFAULT_QUALITY[key] === 'number'));
export const QUALITY_SWITCHES = Object.freeze(Object.keys(DEFAULT_QUALITY).filter(key => typeof DEFAULT_QUALITY[key] === 'boolean'));
const RECEIVER_TYPES = Object.freeze(['omni', 'binaural']);
const LEVEL_MODES = Object.freeze(['peak', 'fixed']);

const PLACE_NAME_LENGTH = 120;
export const DEFAULT_PLACE = Object.freeze({ name: 'Koli', latitude: 63.0964, longitude: 29.8061 });

export const PLACE_NAME_KINDS = Object.freeze(['city', 'town', 'village', 'peak', 'water', 'hamlet', 'locality']);

export const TERRAIN_DEFAULTS = Object.freeze({ enabled: true, shielding: true, echoes: true, scattering: .5, echoCellMetres: 100, echoLimit: 500 });

/** A null reliability marks a placement or output choice, not a model value. */
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
  treeHeightMetres: { minimum: 2, maximum: 50, unit: 'm', label: 'Tree height', reliability: 'C' },
  forestDensity: { minimum: .05, maximum: 1, unit: '', label: 'Forest density', reliability: 'C' },
  shadowFloorDecibels: { minimum: 10, maximum: 60, unit: 'dB', label: 'Shadow floor', reliability: 'C' },
  windSpeedMetresPerSecond: { minimum: 0, maximum: 40, unit: 'm/s', label: 'Wind', reliability: null },
  windFromDegrees: { minimum: 0, maximum: 360, unit: '°', label: 'Wind from', reliability: null },
  upperWindMetresPerSecond: { minimum: 0, maximum: 120, unit: 'm/s', label: 'Upper wind', reliability: 'C' },
  upperWindFromDegrees: { minimum: 0, maximum: 360, unit: '°', label: 'Upper wind from', reliability: null },
  windShearPerSecond: { minimum: -.02, maximum: .02, unit: '1/s', label: 'Wind shear', reliability: 'C' },
  latitude: { minimum: -85, maximum: 85, unit: '°', label: 'Latitude', reliability: null },
  longitude: { minimum: -180, maximum: 180, unit: '°', label: 'Longitude', reliability: null },
  terrainCellMetres: { minimum: 5, maximum: 200, unit: 'm', label: 'Resolution', reliability: null },
  scattering: { minimum: 0, maximum: 1, unit: '', label: 'Scattering', reliability: 'C' },
  echoCellMetres: { minimum: 25, maximum: 500, unit: 'm', label: 'Echo cells', reliability: 'C' },
  echoLimit: { minimum: 10, maximum: 2000, unit: '', label: 'Echoes per cell', reliability: 'C', integer: true },
  coordinateMetres: { minimum: -RENDER.sceneExtentMetres, maximum: RENDER.sceneExtentMetres, unit: 'm', reliability: null },
  heightMetres: { minimum: 0, maximum: RENDER.maximumHeightMetres, unit: 'm', reliability: null },
  fullScalePa: { minimum: .01, maximum: 1e5, unit: 'Pa', label: 'Full scale', reliability: null },
  distanceLossPercent: { minimum: 0, maximum: 100, unit: '%', label: 'Distance loss', reliability: 'C' },
  ambisonicOrder: { minimum: 0, maximum: MAXIMUM_AMBISONIC_ORDER, unit: '', label: 'Ambisonic order', reliability: null, integer: true },
  cutoffDecibels: { minimum: -140, maximum: -60, unit: 'dB', label: 'Cutoff level', reliability: null },
  highestFrequencyHz: { minimum: 1000, maximum: SAMPLE_RATE_HZ / 2, unit: 'Hz', label: 'Highest frequency', reliability: null },
  sourceMerge: { minimum: 1, maximum: 8, unit: '', label: 'Flash detail', reliability: null, integer: true },
  echoCellScale: { minimum: 1, maximum: 4, unit: '×', label: 'Echo detail', reliability: null },
  scatterArrivals: { minimum: 4, maximum: 24, unit: '', label: 'Scatter arrivals', reliability: null, integer: true },
  facingDegrees: { minimum: 0, maximum: 360, unit: '°', label: 'Facing', reliability: null },
  pitchDegrees: { minimum: -90, maximum: 90, unit: '°', label: 'Elevation', reliability: null }
});

const AIR_LAYER_NUMBERS = Object.freeze([
  'windSpeedMetresPerSecond', 'windFromDegrees', 'windShearPerSecond', 'upperWindMetresPerSecond', 'upperWindFromDegrees', 'humidityScaleHeightMetres',
  'groundLayerMetres', 'groundLayerLapseKelvinPerMetre', 'tropopauseMetres'
]);

export class SceneError extends Error {}

export function defaultReceiver(id = 'receiver-1', name = 'Mic 1', { type = 'omni', listen = true } = {}) {
  return { id, name, type, listen, positionMetres: { x: 2000, y: 0, z: 1.7 }, headingDegrees: 270, pitchDegrees: 0 };
}

export function headingToward(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return dx === 0 && dy === 0 ? 0 : Math.round((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360) % 360;
}

const coordinatesText = ({ latitude, longitude }) => `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
export const placeLabel = value => value.name || coordinatesText(value);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function filled(value, defaults) {
  if (!isRecord(defaults)) return value === undefined ? structuredClone(defaults) : value;
  if (!isRecord(value)) return value === undefined ? structuredClone(defaults) : value;
  const result = { ...value };
  for (const [key, fallback] of Object.entries(defaults)) result[key] = filled(value[key], fallback);
  return result;
}

function check(condition, message) {
  if (!condition) throw new SceneError(message);
}

export function createScene({ name, format, version, modelVersion, anchor, modes: modeTable, kinds, parameters: own = {} }) {
  const shadowed = Object.keys(own).filter(key => key in PARAMETERS);
  if (shadowed.length) throw new Error(`Shared scene parameters cannot be redefined: ${shadowed.join(', ')}.`);
  const parameters = Object.freeze({ ...PARAMETERS, ...own });
  const modes = Object.freeze(Object.keys(modeTable));
  let bringIntoRange = false;

  function number(value, key, path) {
    const range = parameters[key];
    check(typeof value === 'number' && Number.isFinite(value), `${path} must be a number.`);
    if (bringIntoRange) {
      const inRange = Math.min(range.maximum, Math.max(range.minimum, value));
      return range.integer ? Math.min(range.maximum, Math.max(range.minimum, Math.round(inRange))) : inRange;
    }
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

  const fields = Object.freeze({ check, number, point, text, numbers });

  function defaultScene(mode = modes[0]) {
    const { emitter: newEmitter, receiverMetres } = modeTable[mode];
    const receiver = defaultReceiver('receiver-1', 'Mic 1', { type: 'binaural' });
    receiver.positionMetres = { ...receiverMetres };
    const emitter = newEmitter();
    receiver.headingDegrees = headingToward(receiver.positionMetres, anchor(emitter));
    return {
      format,
      version,
      mode,
      modelVersion,
      air: {
        temperatureCelsius: 15, lapseRateKelvinPerMetre: ISA_LAPSE_RATE_KELVIN_PER_METRE, relativeHumidityPercent: 70, pressureKpa: 101.325,
        refraction: true, shadowFloorDecibels: 25, absorption: true, turbulenceStrength: 1e-6, turbulenceScaleMetres: 1.1,
        windSpeedMetresPerSecond: 0, windFromDegrees: 270, windShearPerSecond: 0, upperWindMetresPerSecond: 30, upperWindFromDegrees: 270, humidityScaleHeightMetres: 2000,
        groundLayerMetres: 0, groundLayerLapseKelvinPerMetre: -.02, tropopauseMetres: 11000
      },
      ground: { enabled: true, type: 'grass', forest: true, treeHeightMetres: 15, forestDensity: 1, surroundings: true },
      place: { ...DEFAULT_PLACE },
      terrain: null,
      emitters: [emitter],
      receivers: [receiver],
      render: { sampleRate: SAMPLE_RATE_HZ, levelMode: 'peak', fullScalePa: 20, distanceLossPercent: 100, ambisonicOrder: 1, earReflex: false, earLoudness: false, earCapOnsets: true, quality: { ...DEFAULT_QUALITY } }
    };
  }

  function emitter(value, index) {
    const path = `emitters[${index}]`;
    check(value && typeof value === 'object', `${path} is missing.`);
    check(Object.hasOwn(kinds, value.kind), `${path}.kind is not supported.`);
    check(typeof value.enabled === 'boolean', `${path}.enabled must be true or false.`);
    check(isSeed(value.seed), `${path}.seed must be a 32-bit unsigned integer.`);
    const common = { id: text(value.id, `${path}.id`), name: text(value.name, `${path}.name`), kind: value.kind, enabled: value.enabled, seed: value.seed };
    return { ...common, ...kinds[value.kind].read(value, fields, path) };
  }

  function terrain(value) {
    if (value === null || value === undefined) return null;
    check(typeof value === 'object', 'terrain must be an object or null.');
    check(typeof value.enabled === 'boolean' && typeof value.shielding === 'boolean' && typeof value.echoes === 'boolean', 'terrain.enabled, terrain.shielding, and terrain.echoes must be true or false.');
    check(Number.isFinite(value.cellMetres) && value.cellMetres > 0 && value.cellMetres <= GROUND.terrain.maximumCellMetres, 'terrain.cellMetres must be a positive number of metres.');
    check(Number.isFinite(value.datumMetres), 'terrain.datumMetres must be a number.');
    const cells = GROUND.terrain.patchCells;
    check(Array.isArray(value.patches) && value.patches.length >= 1 && value.patches.length <= GROUND.terrain.maximumPatches, `terrain.patches must hold 1–${GROUND.terrain.maximumPatches} patches.`);
    const patches = value.patches.map((patch, index) => {
      const path = `terrain.patches[${index}]`;
      check(patch && Number.isInteger(patch.column) && Number.isInteger(patch.row), `${path} needs a whole column and row.`);
      check(Number.isFinite(patch.baseMetres) && Number.isFinite(patch.stepMetres) && patch.stepMetres > 0, `${path}.baseMetres and stepMetres must be numbers.`);
      check(typeof patch.heights === 'string' && patch.heights.length === 4 * Math.ceil(cells * cells * 2 / 3), `${path}.heights do not match its grid.`);
      return { column: patch.column, row: patch.row, baseMetres: patch.baseMetres, stepMetres: patch.stepMetres, heights: patch.heights };
    });
    const range = terrainRange({ patches });
    check(new Set(patches.map(patch => `${patch.column},${patch.row}`)).size === patches.length && patches.length === patchCount(range), 'terrain.patches must fill a rectangle once each.');
    const bounds = rangeBounds(range, value.cellMetres);
    check(Array.isArray(value.names) && value.names.length <= GROUND.terrain.maximumPlaceNames, 'terrain.names must be a list of place names.');
    const names = value.names.map((item, index) => {
      const path = `terrain.names[${index}]`;
      check(item && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 80, `${path}.name must be a short text.`);
      check(PLACE_NAME_KINDS.includes(item.kind), `${path}.kind is not supported.`);
      check([item.x, item.y].every(Number.isFinite) && item.x >= bounds.west && item.x <= bounds.east && item.y >= bounds.south && item.y <= bounds.north, `${path} must lie within the terrain.`);
      check(item.elevationMetres === null || Number.isFinite(item.elevationMetres), `${path}.elevationMetres must be a number or null.`);
      return { name: item.name, kind: item.kind, x: item.x, y: item.y, elevationMetres: item.elevationMetres };
    });
    return {
      enabled: value.enabled,
      shielding: value.shielding,
      echoes: value.echoes,
      ...numbers(value, ['scattering', 'echoCellMetres', 'echoLimit'], 'terrain'),
      names,
      latitude: number(value.latitude, 'latitude', 'terrain.latitude'),
      longitude: number(value.longitude, 'longitude', 'terrain.longitude'),
      cellMetres: value.cellMetres,
      datumMetres: value.datumMetres,
      patches
    };
  }

  function place(value) {
    check(value && typeof value === 'object', 'place is missing.');
    check(typeof value.name === 'string' && value.name.length <= PLACE_NAME_LENGTH, 'place.name must be a short text.');
    return { name: value.name, latitude: number(value.latitude, 'latitude', 'place.latitude'), longitude: number(value.longitude, 'longitude', 'place.longitude') };
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
      headingDegrees: number(value.headingDegrees, 'facingDegrees', `${path}.headingDegrees`),
      pitchDegrees: number(value.pitchDegrees, 'pitchDegrees', `${path}.pitchDegrees`)
    };
  }

  function uniqueIds(items, path) {
    check(new Set(items.map(item => item.id)).size === items.length, `${path} ids must be unique.`);
  }

  function parseScene(value) {
    check(value && typeof value === 'object', 'The scene is not an object.');
    check(value.format === format, `This is not a ${name} scene.`);
    check(modes.includes(value.mode), 'The scene mode is not supported.');
    const air = value.air ?? {};
    check(typeof air.absorption === 'boolean', 'air.absorption must be true or false.');
    check(typeof air.refraction === 'boolean', 'air.refraction must be true or false.');
    const ground = value.ground ?? {};
    check(typeof ground.enabled === 'boolean', 'ground.enabled must be true or false.');
    check(GROUND_TYPES.includes(ground.type), 'ground.type is not supported.');
    check(typeof ground.forest === 'boolean', 'ground.forest must be true or false.');
    check(typeof ground.surroundings === 'boolean', 'ground.surroundings must be true or false.');
    check(Array.isArray(value.emitters) && value.emitters.length <= RENDER.maximumEmitters,
      `A scene holds at most ${RENDER.maximumEmitters} emitters.`);
    check(Array.isArray(value.receivers) && value.receivers.length >= 1 && value.receivers.length <= RENDER.maximumReceivers,
      `A scene needs 1–${RENDER.maximumReceivers} receivers.`);
    const render = value.render ?? {};
    check(render.sampleRate === SAMPLE_RATE_HZ, `render.sampleRate must be ${SAMPLE_RATE_HZ}.`);
    check(LEVEL_MODES.includes(render.levelMode), 'render.levelMode is not supported.');
    check(typeof render.earReflex === 'boolean' && typeof render.earLoudness === 'boolean' && typeof render.earCapOnsets === 'boolean', 'render.earReflex, render.earLoudness, and render.earCapOnsets must be true or false.');
    const scene = {
      format,
      version,
      mode: value.mode,
      modelVersion,
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
        ...numbers(air, AIR_LAYER_NUMBERS, 'air')
      },
      ground: { enabled: ground.enabled, type: ground.type, forest: ground.forest, treeHeightMetres: number(ground.treeHeightMetres, 'treeHeightMetres', 'ground.treeHeightMetres'), forestDensity: number(ground.forestDensity, 'forestDensity', 'ground.forestDensity'), surroundings: ground.surroundings },
      place: place(value.place),
      terrain: terrain(value.terrain),
      emitters: value.emitters.map(emitter),
      receivers: value.receivers.map(receiver),
      render: {
        sampleRate: render.sampleRate,
        levelMode: render.levelMode,
        fullScalePa: number(render.fullScalePa, 'fullScalePa', 'render.fullScalePa'),
        distanceLossPercent: number(render.distanceLossPercent, 'distanceLossPercent', 'render.distanceLossPercent'),
        ambisonicOrder: number(render.ambisonicOrder, 'ambisonicOrder', 'render.ambisonicOrder'),
        earReflex: render.earReflex,
        earLoudness: render.earLoudness,
        earCapOnsets: render.earCapOnsets,
        quality: {
          ...Object.fromEntries(QUALITY_NUMBERS.map(key => [key, number(render.quality?.[key], key, `render.quality.${key}`)])),
          ...Object.fromEntries(QUALITY_SWITCHES.map(key => {
            check(typeof render.quality?.[key] === 'boolean', `render.quality.${key} must be true or false.`);
            return [key, render.quality[key]];
          }))
        }
      }
    };
    scene.emitters.forEach((item, index) => check(modeTable[scene.mode].kinds.includes(item.kind), `emitters[${index}] does not belong in ${scene.mode} mode.`));
    uniqueIds(scene.emitters, 'Emitter');
    uniqueIds(scene.receivers, 'Receiver');
    check(!scene.terrain || (scene.terrain.latitude === scene.place.latitude && scene.terrain.longitude === scene.place.longitude), 'The terrain must lie at the scene\'s place.');
    return scene;
  }

  const serializeScene = scene => JSON.stringify(parseScene(scene), null, 2);

  function readScene(value) {
    check(isRecord(value) && value.format === format, `This is not a ${name} scene.`);
    const base = defaultScene(modes.includes(value.mode) ? value.mode : undefined);
    const scene = filled({ ...value, emitters: undefined, receivers: undefined, terrain: undefined }, { ...base, emitters: undefined, receivers: undefined, terrain: undefined });
    scene.emitters = Array.isArray(value.emitters)
      ? value.emitters.map(item => (isRecord(item) && Object.hasOwn(kinds, item.kind) ? filled(item, kinds[item.kind].defaults(item)) : item))
      : base.emitters;
    scene.receivers = Array.isArray(value.receivers) ? value.receivers.map(item => filled(item, defaultReceiver())) : base.receivers;
    scene.terrain = isRecord(value.terrain) ? filled(value.terrain, TERRAIN_DEFAULTS) : null;
    const { terrain: saved } = scene;
    if (isRecord(scene.place) && saved && (saved.latitude !== scene.place.latitude || saved.longitude !== scene.place.longitude)
      && [saved.latitude, saved.longitude].every(Number.isFinite)) {
      scene.place = { name: coordinatesText(saved), latitude: saved.latitude, longitude: saved.longitude };
    }
    if (isRecord(scene.place) && typeof scene.place.name === 'string') scene.place.name = scene.place.name.slice(0, PLACE_NAME_LENGTH);
    bringIntoRange = true;
    try {
      return parseScene(scene);
    } finally {
      bringIntoRange = false;
    }
  }

  const sceneInMode = (current, saved) => parseScene({ ...saved, place: current.place, terrain: current.terrain });

  return Object.freeze({ PARAMETERS: parameters, MODES: modes, defaultScene, parseScene, readScene, serializeScene, sceneInMode });
}
