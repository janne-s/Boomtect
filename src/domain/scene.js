import { FLIGHT, MODEL_VERSION, THUNDER } from './constants.js';
import { createScene } from '../shared/domain/scene.js';
import { BLAST_PULSE } from './emitters.js';
import { EXPLOSIVE_TYPES } from './explosives.js';
import { BODY_TYPES } from './flight.js';
import { FLASH_TYPES } from './lightning.js';
import { applyEruption, ERUPTION_NUMBERS } from './volcano.js';

export { DEFAULT_PLACE, DEFAULT_QUALITY, defaultReceiver, headingToward, PLACE_NAME_KINDS, placeLabel, QUALITY_NUMBERS, QUALITY_SWITCHES, SceneError, TERRAIN_DEFAULTS } from '../shared/domain/scene.js';

const BOOMTECT_PARAMETERS = Object.freeze({
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
  chargeKilograms: { minimum: .001, maximum: 3.5e8, unit: 'kg TNT', label: 'Charge', reliability: 'B' },
  linearScaledDistance: { minimum: 5, maximum: 100, unit: 'm/kg^⅓', label: 'Linearization distance', reliability: 'C' },
  durationSecondsPerCubeRootKilogram: { minimum: 1e-4, maximum: .05, unit: 's/kg^⅓', label: 'Positive phase', reliability: 'C' },
  decay: { minimum: .1, maximum: 5, unit: '', label: 'Decay b', reliability: 'C' },
  roundCount: { minimum: 1, maximum: 200, unit: '', label: 'Rounds', reliability: null, integer: true },
  salvoSize: { minimum: 1, maximum: 24, unit: '', label: 'Rounds per salvo', reliability: null, integer: true },
  salvoSpreadSeconds: { minimum: 0, maximum: 10, unit: 's', label: 'Salvo spread', reliability: 'C' },
  chargeSpread: { minimum: 0, maximum: 1.5, unit: '', label: 'Charge spread σ', reliability: 'C' },
  airburstShare: { minimum: 0, maximum: 1, unit: '', label: 'Airbursts', reliability: null },
  airburstHeightMetres: { minimum: 2, maximum: 1000, unit: 'm', label: 'Airburst height', reliability: null },
  shellCount: { minimum: 1, maximum: 500, unit: '', label: 'Shells', reliability: null, integer: true },
  shellDiameterMillimetres: { minimum: 30, maximum: 400, unit: 'mm', label: 'Shell diameter', reliability: null },
  crackleShare: { minimum: 0, maximum: 1, unit: '', label: 'Crackling shells', reliability: null },
  starCount: { minimum: 1, maximum: 300, unit: '', label: 'Crackling stars', reliability: 'C', integer: true },
  popsPerStar: { minimum: 1, maximum: 50, unit: '', label: 'Pops per star', reliability: 'C', integer: true },
  popMilligrams: { minimum: .001, maximum: 100, unit: 'mg TNT', label: 'Pop charge', reliability: 'C' },
  headingDegrees: { minimum: 0, maximum: 360, unit: '°', label: 'Heading', reliability: null },
  climbDegrees: { minimum: -90, maximum: 90, unit: '°', label: 'Climb', reliability: null },
  mach: { minimum: .3, maximum: 30, unit: '', label: 'Mach', reliability: null },
  accelerationMetresPerSecondSquared: { minimum: -50, maximum: 100, unit: 'm/s²', label: 'Acceleration', reliability: null },
  turnDegreesPerSecond: { minimum: -10, maximum: 10, unit: '°/s', label: 'Turn', reliability: null },
  flightSeconds: { minimum: 1, maximum: 600, unit: 's', label: 'Flight time', reliability: null },
  lengthMetres: { minimum: 1, maximum: 300, unit: 'm', label: 'Length', reliability: 'B' },
  shapeFactor: { minimum: .01, maximum: 2, unit: '', label: 'Shape factor K_S', reliability: 'B' },
  whipMach: { minimum: .5, maximum: 3, unit: '', label: 'Top Mach', reliability: 'B' },
  crackerLengthMetres: { minimum: .01, maximum: .5, unit: 'm', label: 'Cracker length', reliability: 'C' },
  crackerShapeFactor: { minimum: .01, maximum: 1, unit: '', label: 'Cracker shape factor K_S', reliability: 'C' },
  startHeightMetres: { minimum: 1000, maximum: 100000, unit: 'm', label: 'Start height', reliability: null },
  descentDegrees: { minimum: 0, maximum: 90, unit: '°', label: 'Descent angle', reliability: null },
  ballisticKilogramsPerSquareMetre: { minimum: 100, maximum: 50000, unit: 'kg/m²', label: 'Ballistic coefficient', reliability: 'C' },
  entryDegrees: { minimum: 5, maximum: 90, unit: '°', label: 'Entry angle', reliability: null },
  speedKilometresPerSecond: { minimum: 11, maximum: 72, unit: 'km/s', label: 'Speed', reliability: 'B' },
  diameterMetres: { minimum: .001, maximum: 50, unit: 'm', label: 'Diameter', reliability: null },
  endHeightMetres: { minimum: 0, maximum: 100000, unit: 'm', label: 'End height', reliability: 'C' },
  dragCoefficient: { minimum: .3, maximum: 3, unit: '', label: 'Drag coefficient', reliability: 'C' },
  densityKilogramsPerCubicMetre: { minimum: 300, maximum: 8000, unit: 'kg/m³', label: 'Density', reliability: 'B' },
  strengthMegapascals: { minimum: .01, maximum: 100, unit: 'MPa', label: 'Strength', reliability: 'B' },
  breakupCount: { minimum: 0, maximum: 6, unit: '', label: 'Breakup generations', reliability: 'C', integer: true },
  breakupShare: { minimum: 0, maximum: .5, unit: '', label: 'Breakup energy', reliability: 'C' },
  burstShare: { minimum: 0, maximum: 1, unit: '', label: 'Burst energy', reliability: 'C' },
  meteorCount: { minimum: 1, maximum: 200, unit: '', label: 'Meteors', reliability: null, integer: true },
  diameterSpread: { minimum: 0, maximum: 1.5, unit: '', label: 'Diameter spread σ', reliability: 'C' },
  memberCount: { minimum: 1, maximum: 24, unit: '', label: 'Aircraft', reliability: null, integer: true },
  lateralSpacingMetres: { minimum: 0, maximum: 20000, unit: 'm', label: 'Lateral spacing', reliability: null },
  trailSpacingMetres: { minimum: 0, maximum: 20000, unit: 'm', label: 'Trail spacing', reliability: null },
  fireballDecibels: { minimum: -60, maximum: 0, unit: 'dB', label: 'Fireball', reliability: 'C' },
  fireballSecondsPerSixthRootKilogram: { minimum: .05, maximum: 5, unit: 's/kg^⅙', label: 'Fireball duration', reliability: 'C' },
  riseTimeSeconds: { minimum: 5e-6, maximum: .01, unit: 's', label: 'Rise time', reliability: 'C' },
  pressureAtKilometrePa: { minimum: .1, maximum: 10000, unit: 'Pa', label: 'Pressure at 1 km', reliability: 'B' },
  pulseSeconds: { minimum: .05, maximum: 10, unit: 's', label: 'Positive phase', reliability: 'B' },
  codaDecibels: { minimum: -60, maximum: 0, unit: 'dB', label: 'Coda', reliability: 'C' },
  codaSeconds: { minimum: .2, maximum: 30, unit: 's', label: 'Coda length', reliability: 'C' },
  thumpShare: { minimum: 0, maximum: 1, unit: '', label: 'Thumps', reliability: 'C' }
});

const CHANNEL_NUMBERS = Object.freeze([
  'segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'macroStepMetres', 'macroTortuosityDegrees',
  'branchCount', 'branchDepth', 'branchEnergyRatio', 'energyJoulesPerMetre', 'energyVariation', 'acousticEfficiency',
  'periodCoefficient', 'weakShockLimitRadii', 'riseTimeSeconds'
]);
const GROUND_FLASH_NUMBERS = Object.freeze(['currentDecayHeightMetres', 'inCloudLengthMetres', 'inCloudEnergyRatio', 'inCloudSpeedMetresPerSecond']);
const LIGHTNING_NUMBERS = Object.freeze([
  'startSeconds', ...CHANNEL_NUMBERS, 'branchLengthRatio', 'channelSpeedMetresPerSecond', 'strokeCount', 'strokeIntervalSeconds',
  'strokeIntervalSpread', 'subsequentStrokeEnergyRatio', 'newTerminationProbability', ...GROUND_FLASH_NUMBERS
]);
const STORM_NUMBERS = Object.freeze([
  'startSeconds', 'radiusMetres', 'durationSeconds', 'flashCount', 'groundFlashShare', 'cloudBaseMetres', 'cloudTopMetres',
  'energySpread', 'newTerminationProbability', ...CHANNEL_NUMBERS, ...GROUND_FLASH_NUMBERS
]);
const BLAST_NUMBERS = Object.freeze(['startSeconds', 'chargeKilograms', 'linearScaledDistance', 'durationSecondsPerCubeRootKilogram', 'decay', 'riseTimeSeconds', 'fireballDecibels', 'fireballSecondsPerSixthRootKilogram']);

const BLAST_SOURCE_NUMBERS = Object.freeze(['linearScaledDistance', 'durationSecondsPerCubeRootKilogram', 'decay', 'riseTimeSeconds', 'fireballDecibels', 'fireballSecondsPerSixthRootKilogram']);
const BARRAGE_NUMBERS = Object.freeze([
  'startSeconds', 'radiusMetres', 'durationSeconds', 'roundCount', 'salvoSize', 'salvoSpreadSeconds', 'chargeKilograms', 'chargeSpread',
  'airburstShare', 'airburstHeightMetres', ...BLAST_SOURCE_NUMBERS
]);

const FIREWORKS_NUMBERS = Object.freeze([
  'startSeconds', 'radiusMetres', 'durationSeconds', 'shellCount', 'salvoSize', 'salvoSpreadSeconds', 'shellDiameterMillimetres', 'diameterSpread',
  'crackleShare', 'starCount', 'popsPerStar', 'popMilligrams', 'riseTimeSeconds'
]);

const VOLCANO_NUMBERS = Object.freeze(['startSeconds', ...ERUPTION_NUMBERS]);

const FLIGHT_NUMBERS = Object.freeze(['startSeconds', 'headingDegrees', 'climbDegrees', 'mach', 'accelerationMetresPerSecondSquared', 'turnDegreesPerSecond', 'lengthMetres', 'shapeFactor', 'riseTimeSeconds']);

const WHIP_NUMBERS = Object.freeze(['startSeconds', 'headingDegrees', 'climbDegrees', 'crackerLengthMetres', 'crackerShapeFactor', 'riseTimeSeconds']);

const BOOSTER_NUMBERS = Object.freeze(['startSeconds', 'headingDegrees', 'descentDegrees', 'startHeightMetres', 'mach', 'ballisticKilogramsPerSquareMetre', 'lengthMetres', 'shapeFactor', 'riseTimeSeconds']);

const METEOR_NUMBERS = Object.freeze(['startSeconds', 'headingDegrees', 'entryDegrees', 'speedKilometresPerSecond', 'diameterMetres', 'endHeightMetres', 'dragCoefficient', 'riseTimeSeconds',
  'densityKilogramsPerCubicMetre', 'strengthMegapascals', 'breakupCount', 'breakupShare', 'burstShare']);
const SHOWER_NUMBERS = Object.freeze(['meteorCount', 'radiusMetres', 'durationSeconds', 'diameterSpread']);


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
    explosive: 'tnt',
    secondaryShock: true,
    fireballDecibels: -20,
    fireballSecondsPerSixthRootKilogram: .92,
    ...BLAST_PULSE,
    riseTimeSeconds: 4e-5
  };
}

export function defaultVolcano(id = 'volcano-1', name = 'Volcano', seed = 20261022) {
  const volcano = { id, name, kind: 'volcano', enabled: true, seed, startSeconds: 0, positionMetres: { x: 0, y: 0, z: 0 } };
  applyEruption(volcano, 'vulcanian');
  return volcano;
}

/** Class C as a default. */
export function defaultBarrage(id = 'barrage-1', name = 'Barrage', seed = 20261012) {
  const blast = defaultBlast();
  return {
    id, name, kind: 'barrage', enabled: true, seed,
    startSeconds: 0,
    centreMetres: { x: 0, y: 0, z: 0 },
    radiusMetres: 150,
    durationSeconds: 60,
    roundCount: 24,
    salvoSize: 6,
    salvoSpreadSeconds: 1.5,
    chargeKilograms: 7,
    chargeSpread: .2,
    airburstShare: 0,
    airburstHeightMetres: 10,
    explosive: 'compB',
    secondaryShock: true,
    ...Object.fromEntries(BLAST_SOURCE_NUMBERS.map(key => [key, blast[key]]))
  };
}

/** Class C, see FIREWORKS. */
export function defaultFireworks(id = 'fireworks-1', name = 'Fireworks', seed = 20261019) {
  return {
    id, name, kind: 'fireworks', enabled: true, seed,
    startSeconds: 0,
    centreMetres: { x: 0, y: 0, z: 0 },
    radiusMetres: 30,
    durationSeconds: 60,
    shellCount: 30,
    salvoSize: 2,
    salvoSpreadSeconds: .5,
    shellDiameterMillimetres: 100,
    diameterSpread: .3,
    crackleShare: .3,
    starCount: 40,
    popsPerStar: 10,
    popMilligrams: .1,
    riseTimeSeconds: 4e-5
  };
}

/** Rise time class C until verified. */
export function defaultFlight(id = 'flight-1', name = 'Flight', seed = 20261013) {
  const body = FLIGHT.bodies.reconnaissance;
  return {
    id, name, kind: 'flight', enabled: true, seed,
    startSeconds: 0,
    body: 'reconnaissance',
    startMetres: { x: -8000, y: 0, z: 6000 },
    headingDegrees: 90,
    climbDegrees: 0,
    mach: 1.6,
    accelerationMetresPerSecondSquared: 0,
    turnDegreesPerSecond: 0,
    durationSeconds: 30,
    lengthMetres: body.lengthMetres,
    shapeFactor: body.shapeFactor,
    riseTimeSeconds: .002
  };
}

/** Class B: Chelyabinsk's track (Borovička et al. 2013, Popova et al. 2013); rise time and breakup class C. */
export function defaultMeteor(id = 'meteor-1', name = 'Meteor', seed = 20261015) {
  return {
    id, name, kind: 'meteor', enabled: true, seed,
    startMetres: { x: -218913, y: -90540, z: 100000 },
    startSeconds: 0,
    headingDegrees: 77,
    entryDegrees: 18,
    speedKilometresPerSecond: 19,
    diameterMetres: 1,
    endHeightMetres: 27000,
    dragCoefficient: 1,
    riseTimeSeconds: .001,
    densityKilogramsPerCubicMetre: 3300,
    strengthMegapascals: 1,
    breakupCount: 3,
    breakupShare: .1,
    burstShare: .5
  };
}

export function defaultShower(id = 'shower-1', name = 'Shower', seed = 20261016) {
  return {
    ...defaultMeteor(id, name, seed), kind: 'shower', startMetres: { x: -40000, y: 0, z: 100000 }, headingDegrees: 90, entryDegrees: 35, speedKilometresPerSecond: 20,
    diameterMetres: .2, endHeightMetres: 25000, breakupCount: 2, meteorCount: 30, radiusMetres: 30000, durationSeconds: 60, diameterSpread: .8
  };
}

/** Class C. */
export function defaultWhip(id = 'whip-1', name = 'Whip', seed = 20261017) {
  return {
    id, name, kind: 'whip', enabled: true, seed,
    startSeconds: 0,
    startMetres: { x: -3, y: 0, z: 1.5 },
    headingDegrees: 90,
    climbDegrees: 0,
    mach: 2.19,
    crackerLengthMetres: .08,
    crackerShapeFactor: .08,
    riseTimeSeconds: 1e-5
  };
}

/** Class C, K_S fitted to Durrant et al. 2022 at 8 km. */
export function defaultBooster(id = 'booster-1', name = 'Booster', seed = 20261018) {
  return {
    id, name, kind: 'booster', enabled: true, seed,
    startSeconds: 0,
    padMetres: { x: -8000, y: 0, z: 0 },
    headingDegrees: 90,
    descentDegrees: 70,
    startHeightMetres: 40000,
    mach: 2.5,
    ballisticKilogramsPerSquareMetre: 1500,
    lengthMetres: 47,
    shapeFactor: .1,
    riseTimeSeconds: .002
  };
}

export function defaultFormation(id = 'formation-1', name = 'Formation', seed = 20261014) {
  return { ...defaultFlight(id, name, seed), kind: 'formation', memberCount: 4, lateralSpacingMetres: 1000, trailSpacingMetres: 1500 };
}

export const emitterAnchor = emitter => emitter.positionMetres ?? emitter.centreMetres ?? emitter.padMetres ?? emitter.startMetres ?? emitter.baseMetres;

function blastFields({ check, point, numbers }, value, path, numberKeys, place) {
  check(EXPLOSIVE_TYPES.includes(value.explosive), `${path}.explosive is not supported.`);
  check(typeof value.secondaryShock === 'boolean', `${path}.secondaryShock must be true or false.`);
  return { [place]: point(value[place], `${path}.${place}`), explosive: value.explosive, secondaryShock: value.secondaryShock, ...numbers(value, numberKeys, path) };
}

function onGround(check, item, place, path) {
  check(item[place].z === 0, `${path}.${place} must lie on the ground.`);
  return item;
}

function readMeteor(value, { check, point, numbers }, path) {
  const meteor = {
    startMetres: point(value.startMetres, `${path}.startMetres`), ...numbers(value, METEOR_NUMBERS, path),
    ...(value.kind === 'shower' ? numbers(value, SHOWER_NUMBERS, path) : {})
  };
  check(meteor.endHeightMetres < meteor.startMetres.z, `${path} must end below its start.`);
  return meteor;
}

function readFlight(value, { check, number, point, numbers }, path) {
  check(BODY_TYPES.includes(value.body), `${path}.body is not supported.`);
  return {
    body: value.body, startMetres: point(value.startMetres, `${path}.startMetres`),
    durationSeconds: number(value.durationSeconds, 'flightSeconds', `${path}.durationSeconds`), ...numbers(value, FLIGHT_NUMBERS, path),
    ...(value.kind === 'formation' ? numbers(value, ['memberCount', 'lateralSpacingMetres', 'trailSpacingMetres'], path) : {})
  };
}

function readLightning(value, { check, point, numbers }, path) {
  check(FLASH_TYPES.includes(value.flashType), `${path}.flashType is not supported.`);
  const lightning = {
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

function readStorm(value, { check, point, numbers }, path) {
  const storm = onGround(check, { centreMetres: point(value.centreMetres, `${path}.centreMetres`), ...numbers(value, STORM_NUMBERS, path) }, 'centreMetres', path);
  check(storm.cloudTopMetres >= storm.cloudBaseMetres + THUNDER.minimumCloudDepthMetres, `${path} needs a cloud top above its cloud base.`);
  check(storm.straightLengthMetres <= storm.segmentLengthMetres, `${path}.straightLengthMetres must not exceed the segment length.`);
  return storm;
}

const KINDS = Object.freeze({
  lightning: { defaults: value => (value.flashType === 'intra-cloud' ? defaultCloudFlash() : defaultLightning()), read: readLightning },
  storm: { defaults: () => defaultStorm(), read: readStorm },
  blast: { defaults: () => defaultBlast(), read: (value, fields, path) => blastFields(fields, value, path, BLAST_NUMBERS, 'positionMetres') },
  barrage: { defaults: () => defaultBarrage(), read: (value, fields, path) => onGround(fields.check, blastFields(fields, value, path, BARRAGE_NUMBERS, 'centreMetres'), 'centreMetres', path) },
  volcano: { defaults: () => defaultVolcano(), read: (value, { check, point, numbers }, path) => onGround(check, { positionMetres: point(value.positionMetres, `${path}.positionMetres`), ...numbers(value, VOLCANO_NUMBERS, path) }, 'positionMetres', path) },
  fireworks: { defaults: () => defaultFireworks(), read: (value, { check, point, numbers }, path) => onGround(check, { centreMetres: point(value.centreMetres, `${path}.centreMetres`), ...numbers(value, FIREWORKS_NUMBERS, path) }, 'centreMetres', path) },
  flight: { defaults: () => defaultFlight(), read: readFlight },
  formation: { defaults: () => defaultFormation(), read: readFlight },
  meteor: { defaults: () => defaultMeteor(), read: readMeteor },
  shower: { defaults: () => defaultShower(), read: readMeteor },
  whip: { defaults: () => defaultWhip(), read: (value, { number, point, numbers }, path) => ({ startMetres: point(value.startMetres, `${path}.startMetres`), mach: number(value.mach, 'whipMach', `${path}.mach`), ...numbers(value, WHIP_NUMBERS, path) }) },
  booster: { defaults: () => defaultBooster(), read: (value, { check, point, numbers }, path) => onGround(check, { padMetres: point(value.padMetres, `${path}.padMetres`), ...numbers(value, BOOSTER_NUMBERS, path) }, 'padMetres', path) }
});

export const { PARAMETERS, MODES, defaultScene, parseScene, readScene, serializeScene, sceneInMode } = createScene({
  name: 'Boomtect',
  format: 'boomtect.scene',
  version: 30,
  modelVersion: MODEL_VERSION,
  anchor: emitterAnchor,
  modes: {
    thunder: { kinds: ['lightning', 'storm'], emitter: () => defaultLightning(), receiverMetres: { x: 1400, y: 0, z: 1.7 } },
    blast: { kinds: ['blast', 'barrage', 'fireworks', 'volcano'], emitter: () => defaultBlast(), receiverMetres: { x: 400, y: 0, z: 1.7 } },
    sonic: { kinds: ['flight', 'formation', 'meteor', 'shower', 'whip', 'booster'], emitter: () => defaultFlight(), receiverMetres: { x: 0, y: 0, z: 1.7 } }
  },
  kinds: KINDS,
  parameters: BOOMTECT_PARAMETERS
});
