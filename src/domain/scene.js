import {
  MAXIMUM_EMITTERS, MAXIMUM_HEIGHT_METRES, MAXIMUM_RECEIVERS, MODEL_VERSION, SAMPLE_RATE_HZ, SCENE_EXTENT_METRES
} from './constants.js';
import { EMITTER_KINDS } from './emitters.js';
import { GROUND_TYPES } from './ground.js';
import { isSeed } from './random.js';

export const SCENE_FORMAT = 'boomtect.scene';
export const SCENE_VERSION = 1;
export const LEVEL_MODES = Object.freeze(['peak', 'fixed']);

/**
 * Every bounded number in a scene: unit, range, and reliability class of the value it controls.
 * Class A comes from first principles, B from literature, C from heuristic or synthetic choice.
 */
export const PARAMETERS = Object.freeze({
  temperatureCelsius: { minimum: -40, maximum: 50, unit: '°C', label: 'Temperature', reliability: 'A' },
  relativeHumidityPercent: { minimum: 0, maximum: 100, unit: '%', label: 'Humidity', reliability: 'B' },
  pressureKpa: { minimum: 50, maximum: 110, unit: 'kPa', label: 'Pressure', reliability: 'A' },
  coordinateMetres: { minimum: -SCENE_EXTENT_METRES, maximum: SCENE_EXTENT_METRES, unit: 'm' },
  heightMetres: { minimum: 0, maximum: MAXIMUM_HEIGHT_METRES, unit: 'm' },
  segmentLengthMetres: { minimum: 1, maximum: 100, unit: 'm', label: 'Segment length', reliability: 'C' },
  tortuosityDegrees: { minimum: 0, maximum: 60, unit: '°', label: 'Tortuosity', reliability: 'C' },
  energyJoulesPerMetre: { minimum: 1e3, maximum: 1e7, unit: 'J/m', label: 'Energy per metre', reliability: 'B' },
  acousticEfficiency: { minimum: 1e-4, maximum: .2, unit: '', label: 'Acoustic efficiency', reliability: 'C' },
  frequencyCoefficient: { minimum: .2, maximum: 1, unit: '', label: 'Peak coefficient κ', reliability: 'B' },
  returnStrokeSpeedMetresPerSecond: { minimum: 1e7, maximum: 3e8, unit: 'm/s', label: 'Return stroke speed', reliability: 'B' },
  strokeCount: { minimum: 1, maximum: 20, unit: '', label: 'Strokes', reliability: 'B', integer: true },
  strokeIntervalSeconds: { minimum: .005, maximum: .5, unit: 's', label: 'Stroke interval', reliability: 'B' },
  subsequentStrokeEnergyRatio: { minimum: .05, maximum: 1, unit: '', label: 'Later stroke energy', reliability: 'C' },
  chargeKilograms: { minimum: .001, maximum: 1e6, unit: 'kg TNT', label: 'Charge', reliability: 'B' },
  linearScaledDistance: { minimum: 5, maximum: 100, unit: 'm/kg^⅓', label: 'Linearization distance', reliability: 'C' },
  durationSecondsPerCubeRootKilogram: { minimum: 1e-4, maximum: .05, unit: 's/kg^⅓', label: 'Positive phase', reliability: 'C' },
  decay: { minimum: .1, maximum: 5, unit: '', label: 'Decay b', reliability: 'C' },
  riseTimeSeconds: { minimum: 1e-5, maximum: 1e-3, unit: 's', label: 'Rise time', reliability: 'C' },
  fullScalePa: { minimum: .01, maximum: 1e5, unit: 'Pa', label: 'Full scale', reliability: null }
});

export class SceneError extends Error {}

export function defaultLightning(id = 'lightning-1', name = 'Lightning', seed = 20261009) {
  return {
    id, name, kind: 'lightning', enabled: true, seed,
    baseMetres: { x: 0, y: 0, z: 0 },
    topMetres: { x: 600, y: 0, z: 4000 },
    segmentLengthMetres: 10,
    tortuosityDegrees: 16,
    energyJoulesPerMetre: 5e5,
    acousticEfficiency: .01,
    frequencyCoefficient: 1 / 2.6,
    returnStrokeSpeedMetresPerSecond: 1e8,
    strokeCount: 3,
    strokeIntervalSeconds: .06,
    subsequentStrokeEnergyRatio: .5,
    riseTimeSeconds: 1e-4
  };
}

export function defaultBlast(id = 'blast-1', name = 'Blast', seed = 20261009) {
  return {
    id, name, kind: 'blast', enabled: true, seed,
    positionMetres: { x: 0, y: 0, z: 1 },
    chargeKilograms: 10,
    linearScaledDistance: 20,
    durationSecondsPerCubeRootKilogram: .006,
    decay: 1,
    riseTimeSeconds: 1e-4
  };
}

export function defaultReceiver(id = 'receiver-1', name = 'Mic 1') {
  return { id, name, positionMetres: { x: 2000, y: 0, z: 1.7 } };
}

export function defaultScene() {
  const blast = defaultBlast();
  blast.enabled = false;
  blast.positionMetres = { x: -1000, y: 0, z: 1 };
  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    modelVersion: MODEL_VERSION,
    air: { temperatureCelsius: 15, relativeHumidityPercent: 70, pressureKpa: 101.325, absorption: true },
    ground: { enabled: true, type: 'grass' },
    emitters: [defaultLightning(), blast],
    receivers: [defaultReceiver()],
    render: { sampleRate: SAMPLE_RATE_HZ, levelMode: 'peak', fullScalePa: 20 }
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

function emitter(value, index) {
  const path = `emitters[${index}]`;
  check(value && typeof value === 'object', `${path} is missing.`);
  check(EMITTER_KINDS.includes(value.kind), `${path}.kind is not supported.`);
  check(typeof value.enabled === 'boolean', `${path}.enabled must be true or false.`);
  check(isSeed(value.seed), `${path}.seed must be a 32-bit unsigned integer.`);
  const common = { id: text(value.id, `${path}.id`), name: text(value.name, `${path}.name`), kind: value.kind, enabled: value.enabled, seed: value.seed };
  const field = key => number(value[key], key, `${path}.${key}`);
  if (value.kind === 'blast') {
    return {
      ...common,
      positionMetres: point(value.positionMetres, `${path}.positionMetres`),
      chargeKilograms: field('chargeKilograms'),
      linearScaledDistance: field('linearScaledDistance'),
      durationSecondsPerCubeRootKilogram: field('durationSecondsPerCubeRootKilogram'),
      decay: field('decay'),
      riseTimeSeconds: field('riseTimeSeconds')
    };
  }
  const lightning = {
    ...common,
    baseMetres: point(value.baseMetres, `${path}.baseMetres`),
    topMetres: point(value.topMetres, `${path}.topMetres`),
    segmentLengthMetres: field('segmentLengthMetres'),
    tortuosityDegrees: field('tortuosityDegrees'),
    energyJoulesPerMetre: field('energyJoulesPerMetre'),
    acousticEfficiency: field('acousticEfficiency'),
    frequencyCoefficient: field('frequencyCoefficient'),
    returnStrokeSpeedMetresPerSecond: field('returnStrokeSpeedMetresPerSecond'),
    strokeCount: field('strokeCount'),
    strokeIntervalSeconds: field('strokeIntervalSeconds'),
    subsequentStrokeEnergyRatio: field('subsequentStrokeEnergyRatio'),
    riseTimeSeconds: field('riseTimeSeconds')
  };
  const { baseMetres: base, topMetres: top } = lightning;
  check(Math.hypot(top.x - base.x, top.y - base.y, top.z - base.z) >= lightning.segmentLengthMetres,
    `${path} must be at least one segment long.`);
  return lightning;
}

function receiver(value, index) {
  const path = `receivers[${index}]`;
  check(value && typeof value === 'object', `${path} is missing.`);
  return { id: text(value.id, `${path}.id`), name: text(value.name, `${path}.name`), positionMetres: point(value.positionMetres, `${path}.positionMetres`) };
}

function uniqueIds(items, path) {
  check(new Set(items.map(item => item.id)).size === items.length, `${path} ids must be unique.`);
}

/** Validates a scene document and returns a complete copy, or throws SceneError. */
export function parseScene(value) {
  check(value && typeof value === 'object', 'The scene is not an object.');
  check(value.format === SCENE_FORMAT, 'This is not a Boomtect scene.');
  check(value.version === SCENE_VERSION, `Scene version ${value.version} is not supported.`);
  const air = value.air ?? {};
  check(typeof air.absorption === 'boolean', 'air.absorption must be true or false.');
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
  const scene = {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    modelVersion: MODEL_VERSION,
    air: {
      temperatureCelsius: number(air.temperatureCelsius, 'temperatureCelsius', 'air.temperatureCelsius'),
      relativeHumidityPercent: number(air.relativeHumidityPercent, 'relativeHumidityPercent', 'air.relativeHumidityPercent'),
      pressureKpa: number(air.pressureKpa, 'pressureKpa', 'air.pressureKpa'),
      absorption: air.absorption
    },
    ground: { enabled: ground.enabled, type: ground.type },
    emitters: value.emitters.map(emitter),
    receivers: value.receivers.map(receiver),
    render: { sampleRate: render.sampleRate, levelMode: render.levelMode, fullScalePa: number(render.fullScalePa, 'fullScalePa', 'render.fullScalePa') }
  };
  uniqueIds(scene.emitters, 'Emitter');
  uniqueIds(scene.receivers, 'Receiver');
  return scene;
}

export const serializeScene = scene => JSON.stringify(parseScene(scene), null, 2);
