import { PARAMETERS } from '../domain/scene.js';

/**
 * Macro controls: one slider that sets several detailed parameters at once to change an emitter's
 * character quickly. A macro is a user-interface shortcut, not a model value: it writes ordinary
 * parameters, which keep their own reliability classes and stay editable in the details.
 * Every macro maps a position t in [0, 1] to parameter values, and reads t back from them.
 */

const logPosition = (value, [low, high]) => Math.log(value / low) / Math.log(high / low);
const logValue = (t, [low, high]) => low * (high / low) ** t;
const clamp01 = value => Math.min(1, Math.max(0, value));
const range = key => [PARAMETERS[key].minimum, PARAMETERS[key].maximum];

const ENERGY_RANGE = Object.freeze([3e3, 3e6]);
const CRACK_STRAIGHT_RANGE = Object.freeze([3, .2]);
const MAXIMUM_BRANCHES = 24;
const MAXIMUM_ZIGZAG_DEGREES = 45;
const FINE_TORTUOSITY = Object.freeze([4, 28]);

const percent = t => `${Math.round(t * 100)} %`;
const kilo = (value, unit) => (value >= 1000 ? `${+(value / 1000).toPrecision(3)} k${unit}` : `${+value.toPrecision(3)} ${unit}`);
const metres = value => (value >= 1000 ? `${+(value / 1000).toPrecision(3)} km` : `${Math.round(value)} m`);

const energy = {
  label: 'Energy',
  read: item => clamp01(logPosition(item.energyJoulesPerMetre, ENERGY_RANGE)),
  write: (item, t) => { item.energyJoulesPerMetre = Math.round(logValue(t, ENERGY_RANGE)); },
  show: item => kilo(item.energyJoulesPerMetre, 'J/m')
};

const branching = {
  label: 'Branching',
  read: item => clamp01(item.branchCount / MAXIMUM_BRANCHES),
  write: (item, t) => {
    item.branchCount = Math.round(t * MAXIMUM_BRANCHES);
    item.branchDepth = t === 0 ? 0 : t < .34 ? 1 : t < .67 ? 2 : 3;
    if ('branchLengthRatio' in item) item.branchLengthRatio = +(.15 + .3 * t).toFixed(3);
  },
  show: item => `${item.branchCount} × ${item.branchDepth} levels`
};

const jaggedness = {
  label: 'Zigzag',
  read: item => clamp01(item.macroTortuosityDegrees / MAXIMUM_ZIGZAG_DEGREES),
  write: (item, t) => {
    item.macroTortuosityDegrees = Math.round(t * MAXIMUM_ZIGZAG_DEGREES);
    item.tortuosityDegrees = Math.round(FINE_TORTUOSITY[0] + t * (FINE_TORTUOSITY[1] - FINE_TORTUOSITY[0]));
  },
  show: item => percent(item.macroTortuosityDegrees / MAXIMUM_ZIGZAG_DEGREES)
};

const crack = {
  label: 'Crack',
  read: item => clamp01(logPosition(item.straightLengthMetres, CRACK_STRAIGHT_RANGE)),
  write: (item, t) => { item.straightLengthMetres = Math.min(item.segmentLengthMetres, +logValue(t, CRACK_STRAIGHT_RANGE).toFixed(2)); },
  show: item => `${item.straightLengthMetres} m elements`
};

const strokes = {
  label: 'Strokes',
  read: item => (item.strokeCount - 1) / 11,
  write: (item, t) => { item.strokeCount = 1 + Math.round(t * 11); },
  show: item => String(item.strokeCount),
  steps: 11
};

/** The height of a ground flash's cloud end, or the mean altitude of a cloud flash. */
const height = {
  label: 'Height',
  read: item => clamp01(logPosition(item.flashType === 'cloud-to-ground' ? item.topMetres.z : (item.baseMetres.z + item.topMetres.z) / 2, [300, 15000])),
  write: (item, t) => {
    const target = Math.round(logValue(t, [300, 15000]));
    if (item.flashType === 'cloud-to-ground') item.topMetres = { ...item.topMetres, z: target };
    else {
      const shift = target - (item.baseMetres.z + item.topMetres.z) / 2;
      item.baseMetres = { ...item.baseMetres, z: Math.max(0, Math.round(item.baseMetres.z + shift)) };
      item.topMetres = { ...item.topMetres, z: Math.max(0, Math.round(item.topMetres.z + shift)) };
    }
  },
  show: item => metres(item.flashType === 'cloud-to-ground' ? item.topMetres.z : (item.baseMetres.z + item.topMetres.z) / 2)
};

const stormSize = {
  label: 'Size',
  read: item => clamp01(logPosition(Math.max(500, item.radiusMetres), [500, 30000])),
  write: (item, t) => { item.radiusMetres = Math.round(logValue(t, [500, 30000])); },
  show: item => `${metres(item.radiusMetres)} radius`
};

const stormDuration = {
  label: 'Duration',
  read: item => item.durationSeconds / 120,
  write: (item, t) => { item.durationSeconds = Math.round(t * 120); },
  show: item => `${item.durationSeconds} s`
};

const stormFlashes = {
  label: 'Flashes',
  read: item => (item.flashCount - 1) / 59,
  write: (item, t) => { item.flashCount = 1 + Math.round(t * 59); },
  show: item => String(item.flashCount),
  steps: 59
};

const stormGround = {
  label: 'Ground flashes',
  read: item => item.groundFlashShare,
  write: (item, t) => { item.groundFlashShare = +t.toFixed(2); },
  show: item => percent(item.groundFlashShare)
};

/** The cloud layer: one slider with two handles, base and top. */
const CLOUD_RANGE = Object.freeze([200, 18000]);
const stormCloud = {
  label: 'Cloud layer',
  dual: true,
  read: item => [clamp01(logPosition(item.cloudBaseMetres, CLOUD_RANGE)), clamp01(logPosition(item.cloudTopMetres, CLOUD_RANGE))],
  write: (item, low, high) => {
    const base = Math.min(PARAMETERS.cloudBaseMetres.maximum, Math.max(PARAMETERS.cloudBaseMetres.minimum, Math.round(logValue(low, CLOUD_RANGE))));
    const top = Math.max(PARAMETERS.cloudTopMetres.minimum, Math.round(logValue(high, CLOUD_RANGE)));
    item.cloudBaseMetres = base;
    item.cloudTopMetres = Math.max(top, base + 100);
  },
  show: item => `${metres(item.cloudBaseMetres)}–${metres(item.cloudTopMetres)}`
};

const charge = {
  label: 'Charge',
  read: item => clamp01(logPosition(item.chargeKilograms, range('chargeKilograms'))),
  write: (item, t) => { item.chargeKilograms = +logValue(t, range('chargeKilograms')).toPrecision(3); },
  show: item => {
    const kilograms = item.chargeKilograms;
    if (kilograms < 1) return `${+(kilograms * 1000).toPrecision(3)} g TNT`;
    if (kilograms < 1000) return `${+kilograms.toPrecision(3)} kg TNT`;
    return `${+(kilograms / 1000).toPrecision(3)} t TNT`;
  }
};

const blastHeight = {
  label: 'Height',
  read: item => clamp01(logPosition(Math.max(.5, item.positionMetres.z), [.5, 5000])),
  write: (item, t) => { item.positionMetres = { ...item.positionMetres, z: +logValue(t, [.5, 5000]).toPrecision(3) }; },
  show: item => metres(item.positionMetres.z)
};

const fireball = {
  label: 'Fireball',
  read: item => clamp01((item.fireballDecibels - range('fireballDecibels')[0]) / (range('fireballDecibels')[1] - range('fireballDecibels')[0])),
  write: (item, t) => { const [low, high] = range('fireballDecibels'); item.fireballDecibels = Math.round(low + t * (high - low)); },
  show: item => `${item.fireballDecibels} dB`
};

const barrageSize = {
  label: 'Size',
  read: item => clamp01(logPosition(Math.max(10, item.radiusMetres), [10, 5000])),
  write: (item, t) => { item.radiusMetres = Math.round(logValue(t, [10, 5000])); },
  show: item => `${metres(item.radiusMetres)} radius`
};

const barrageRounds = {
  label: 'Rounds',
  read: item => clamp01(logPosition(item.roundCount, [1, 200])),
  write: (item, t) => { item.roundCount = Math.max(1, Math.round(logValue(t, [1, 200]))); },
  show: item => String(item.roundCount)
};

const barrageSalvo = {
  label: 'Per salvo',
  read: item => (item.salvoSize - 1) / 23,
  write: (item, t) => { item.salvoSize = 1 + Math.round(t * 23); },
  show: item => String(item.salvoSize),
  steps: 23
};

const machNumber = {
  label: 'Mach',
  read: item => clamp01(logPosition(item.mach, [.5, 30])),
  write: (item, t) => { item.mach = +logValue(t, [.5, 30]).toPrecision(3); },
  show: item => item.mach.toFixed(2)
};

const flightHeight = {
  label: 'Height',
  read: item => clamp01(logPosition(Math.max(100, item.startMetres.z), [100, 100000])),
  write: (item, t) => { item.startMetres = { ...item.startMetres, z: Math.round(logValue(t, [100, 100000])) }; },
  show: item => metres(item.startMetres.z)
};

const flightHeading = {
  label: 'Heading',
  read: item => item.headingDegrees / 360,
  write: (item, t) => { item.headingDegrees = Math.round(t * 360) % 360; },
  show: item => `${Math.round(item.headingDegrees)}°`
};

const flightClimb = {
  label: 'Climb',
  read: item => (item.climbDegrees + 90) / 180,
  write: (item, t) => { item.climbDegrees = Math.round(t * 180 - 90); },
  show: item => `${item.climbDegrees}°`
};

const flightAcceleration = {
  label: 'Acceleration',
  read: item => (item.accelerationMetresPerSecondSquared + 50) / 150,
  write: (item, t) => { item.accelerationMetresPerSecondSquared = Math.round(t * 150 - 50); },
  show: item => `${item.accelerationMetresPerSecondSquared} m/s²`
};

const flightTurn = {
  label: 'Turn',
  read: item => (item.turnDegreesPerSecond + 10) / 20,
  write: (item, t) => { item.turnDegreesPerSecond = +(t * 20 - 10).toFixed(1); },
  show: item => `${item.turnDegreesPerSecond}°/s`
};

const flightTime = {
  label: 'Flight time',
  read: item => clamp01(logPosition(item.durationSeconds, [1, 600])),
  write: (item, t) => { item.durationSeconds = Math.max(1, Math.round(logValue(t, [1, 600]))); },
  show: item => `${item.durationSeconds} s`
};

/** Macro sliders for an emitter, in display order. */
export function macrosFor(emitter) {
  if (emitter.kind === 'lightning') return [energy, height, branching, jaggedness, crack, strokes];
  if (emitter.kind === 'storm') return [stormSize, stormDuration, stormFlashes, stormGround, stormCloud, energy, branching, crack];
  if (emitter.kind === 'flight') return [machNumber, flightHeight, flightHeading, flightClimb, flightAcceleration, flightTurn, flightTime];
  if (emitter.kind === 'barrage') return [barrageSize, stormDuration, barrageRounds, barrageSalvo, charge, fireball];
  return [charge, blastHeight, fireball];
}
