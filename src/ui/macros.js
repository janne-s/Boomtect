import { VIEW } from '../domain/constants.js';
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

const percent = t => `${Math.round(t * 100)} %`;
const kilo = (value, unit) => (value >= 1000 ? `${+(value / 1000).toPrecision(3)} k${unit}` : `${+value.toPrecision(3)} ${unit}`);
const metres = value => (value >= 1000 ? `${+(value / 1000).toPrecision(3)} km` : value >= 10 ? `${Math.round(value)} m` : `${+value.toPrecision(2)} m`);

/**
 * A macro that sets one parameter may also take a typed value (`entry`): the parameter in its own
 * unit (`unit`, or metres and TNT equivalents in any of their units), read with `get` and written
 * with `set`. Typed values may go beyond the slider's span, within the parameter's range, which
 * the scene's validation checks.
 */
const UNITS = Object.freeze({
  metres: Object.freeze({ m: 1, km: 1000 }),
  charge: Object.freeze({ g: .001, kg: 1, t: 1000, kt: 1e6 })
});

/** The entry's current value as text to edit, in the unit it is shown in. */
export function entryText(entry, item) {
  const value = entry.get(item);
  if (entry.units === 'metres') return metres(value);
  if (entry.units === 'charge') return formatCharge(value).replace(/ TNT$/, '');
  return `${+value.toPrecision(6)}${entry.unit ? ` ${entry.unit}` : ''}`;
}

/**
 * A typed value in the entry's base unit: a number with a comma or a point, then its unit if it
 * has a choice of them (the shown one when left out), or its own unit, which may be left out.
 */
export function parseEntry(entry, text, item) {
  const match = /^\s*([-+]?(?:\d+[.,]?\d*|[.,]\d+)(?:e[-+]?\d+)?)\s*(.*?)\s*$/i.exec(text);
  if (!match) throw new Error(`${text.trim() || 'An empty value'} is not a number.`);
  let value = Number(match[1].replace(',', '.'));
  const unit = match[2];
  if (entry.units) {
    const units = UNITS[entry.units];
    const shown = entryText(entry, item).split(' ').at(-1);
    const factor = units[unit || shown];
    if (factor === undefined) throw new Error(`Use ${Object.keys(units).join(', ')}.`);
    value *= factor;
  } else if (unit && unit !== entry.unit) throw new Error(entry.unit ? `Use ${entry.unit}.` : 'Give a plain number.');
  if (!Number.isFinite(value)) throw new Error(`${text.trim()} is not a number.`);
  return entry.integer ? Math.round(value) : value;
}

const energy = {
  label: 'Energy',
  read: item => clamp01(logPosition(item.energyJoulesPerMetre, VIEW.macros.energyRange)),
  write: (item, t) => { item.energyJoulesPerMetre = Math.round(logValue(t, VIEW.macros.energyRange)); },
  show: item => kilo(item.energyJoulesPerMetre, 'J/m')
};

const branching = {
  label: 'Branching',
  read: item => clamp01(item.branchCount / VIEW.macros.maximumBranches),
  write: (item, t) => {
    item.branchCount = Math.round(t * VIEW.macros.maximumBranches);
    item.branchDepth = t === 0 ? 0 : t < .34 ? 1 : t < .67 ? 2 : 3;
    if ('branchLengthRatio' in item) item.branchLengthRatio = +(.15 + .3 * t).toFixed(3);
  },
  show: item => `${item.branchCount} × ${item.branchDepth} levels`
};

const jaggedness = {
  label: 'Zigzag',
  read: item => clamp01(item.macroTortuosityDegrees / VIEW.macros.maximumZigzagDegrees),
  write: (item, t) => {
    item.macroTortuosityDegrees = Math.round(t * VIEW.macros.maximumZigzagDegrees);
    item.tortuosityDegrees = Math.round(VIEW.macros.fineTortuosity[0] + t * (VIEW.macros.fineTortuosity[1] - VIEW.macros.fineTortuosity[0]));
  },
  show: item => percent(item.macroTortuosityDegrees / VIEW.macros.maximumZigzagDegrees)
};

const crack = {
  label: 'Crack',
  read: item => clamp01(logPosition(item.straightLengthMetres, VIEW.macros.crackStraightRange)),
  write: (item, t) => { item.straightLengthMetres = Math.min(item.segmentLengthMetres, +logValue(t, VIEW.macros.crackStraightRange).toFixed(2)); },
  show: item => `${item.straightLengthMetres} m elements`
};

const strokes = {
  label: 'Strokes',
  read: item => (item.strokeCount - 1) / 11,
  write: (item, t) => { item.strokeCount = 1 + Math.round(t * 11); },
  show: item => String(item.strokeCount),
  steps: 11,
  entry: { integer: true, get: item => item.strokeCount, set: (item, value) => { item.strokeCount = value; } }
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
  show: item => `${metres(item.radiusMetres)} radius`,
  entry: { units: 'metres', get: item => item.radiusMetres, set: (item, value) => { item.radiusMetres = value; } }
};

const stormDuration = {
  label: 'Duration',
  read: item => item.durationSeconds / 120,
  write: (item, t) => { item.durationSeconds = Math.round(t * 120); },
  show: item => `${item.durationSeconds} s`,
  entry: { unit: 's', get: item => item.durationSeconds, set: (item, value) => { item.durationSeconds = value; } }
};

const stormFlashes = {
  label: 'Flashes',
  read: item => (item.flashCount - 1) / 59,
  write: (item, t) => { item.flashCount = 1 + Math.round(t * 59); },
  show: item => String(item.flashCount),
  steps: 59,
  entry: { integer: true, get: item => item.flashCount, set: (item, value) => { item.flashCount = value; } }
};

const stormGround = {
  label: 'Ground flashes',
  read: item => item.groundFlashShare,
  write: (item, t) => { item.groundFlashShare = +t.toFixed(2); },
  show: item => percent(item.groundFlashShare),
  entry: { unit: '%', get: item => item.groundFlashShare * 100, set: (item, value) => { item.groundFlashShare = value / 100; } }
};

const stormCloud = {
  label: 'Cloud layer',
  dual: true,
  read: item => [clamp01(logPosition(item.cloudBaseMetres, VIEW.macros.cloudRange)), clamp01(logPosition(item.cloudTopMetres, VIEW.macros.cloudRange))],
  write: (item, low, high) => {
    const base = Math.min(PARAMETERS.cloudBaseMetres.maximum, Math.max(PARAMETERS.cloudBaseMetres.minimum, Math.round(logValue(low, VIEW.macros.cloudRange))));
    const top = Math.max(PARAMETERS.cloudTopMetres.minimum, Math.round(logValue(high, VIEW.macros.cloudRange)));
    item.cloudBaseMetres = base;
    item.cloudTopMetres = Math.max(top, base + 100);
  },
  show: item => `${metres(item.cloudBaseMetres)}–${metres(item.cloudTopMetres)}`
};

/** A TNT equivalent in g, kg, t, or kt. */
export function formatCharge(kilograms) {
  if (kilograms < 1) return `${+(kilograms * 1000).toPrecision(3)} g TNT`;
  if (kilograms < 1000) return `${+kilograms.toPrecision(3)} kg TNT`;
  if (kilograms < 1e6) return `${+(kilograms / 1000).toPrecision(3)} t TNT`;
  return `${+(kilograms / 1e6).toPrecision(3)} kt TNT`;
}

const charge = {
  label: 'Charge',
  read: item => clamp01(logPosition(item.chargeKilograms, range('chargeKilograms'))),
  write: (item, t) => { item.chargeKilograms = +logValue(t, range('chargeKilograms')).toPrecision(3); },
  show: item => formatCharge(item.chargeKilograms),
  entry: { units: 'charge', get: item => item.chargeKilograms, set: (item, value) => { item.chargeKilograms = value; } }
};

const blastHeight = {
  label: 'Height',
  read: item => clamp01(logPosition(Math.max(.5, item.positionMetres.z), [.5, 5000])),
  write: (item, t) => { item.positionMetres = { ...item.positionMetres, z: +logValue(t, [.5, 5000]).toPrecision(3) }; },
  show: item => metres(item.positionMetres.z),
  entry: { units: 'metres', get: item => item.positionMetres.z, set: (item, value) => { item.positionMetres = { ...item.positionMetres, z: value }; } }
};

const fireball = {
  label: 'Fireball',
  read: item => clamp01((item.fireballDecibels - range('fireballDecibels')[0]) / (range('fireballDecibels')[1] - range('fireballDecibels')[0])),
  write: (item, t) => { const [low, high] = range('fireballDecibels'); item.fireballDecibels = Math.round(low + t * (high - low)); },
  show: item => `${item.fireballDecibels} dB`,
  entry: { unit: 'dB', get: item => item.fireballDecibels, set: (item, value) => { item.fireballDecibels = value; } }
};

const barrageSize = {
  label: 'Size',
  read: item => clamp01(logPosition(Math.max(10, item.radiusMetres), [10, 5000])),
  write: (item, t) => { item.radiusMetres = Math.round(logValue(t, [10, 5000])); },
  show: item => `${metres(item.radiusMetres)} radius`,
  entry: { units: 'metres', get: item => item.radiusMetres, set: (item, value) => { item.radiusMetres = value; } }
};

const barrageRounds = {
  label: 'Rounds',
  read: item => clamp01(logPosition(item.roundCount, [1, 200])),
  write: (item, t) => { item.roundCount = Math.max(1, Math.round(logValue(t, [1, 200]))); },
  show: item => String(item.roundCount),
  entry: { integer: true, get: item => item.roundCount, set: (item, value) => { item.roundCount = value; } }
};

const barrageSalvo = {
  label: 'Per salvo',
  read: item => (item.salvoSize - 1) / 23,
  write: (item, t) => { item.salvoSize = 1 + Math.round(t * 23); },
  show: item => String(item.salvoSize),
  steps: 23,
  entry: { integer: true, get: item => item.salvoSize, set: (item, value) => { item.salvoSize = value; } }
};

const machNumber = {
  label: 'Mach',
  read: item => clamp01(logPosition(item.mach, [.5, 30])),
  write: (item, t) => { item.mach = +logValue(t, [.5, 30]).toPrecision(3); },
  show: item => item.mach.toFixed(2),
  entry: { get: item => item.mach, set: (item, value) => { item.mach = value; } }
};

const flightHeight = {
  label: 'Height',
  read: item => clamp01(logPosition(Math.max(100, item.startMetres.z), [100, 100000])),
  write: (item, t) => {
    item.startMetres = { ...item.startMetres, z: Math.round(logValue(t, [100, 100000])) };
    // A meteor's trail keeps ending below its start.
    if (item.endHeightMetres !== undefined) item.endHeightMetres = Math.min(item.endHeightMetres, Math.max(0, item.startMetres.z - 1000));
  },
  show: item => metres(item.startMetres.z),
  entry: {
    units: 'metres',
    get: item => item.startMetres.z,
    set: (item, value) => {
      item.startMetres = { ...item.startMetres, z: value };
      if (item.endHeightMetres !== undefined) item.endHeightMetres = Math.min(item.endHeightMetres, Math.max(0, value - 1000));
    }
  }
};

const flightHeading = {
  label: 'Heading',
  read: item => item.headingDegrees / 360,
  write: (item, t) => { item.headingDegrees = Math.round(t * 360) % 360; },
  show: item => `${Math.round(item.headingDegrees)}°`,
  entry: { unit: '°', get: item => item.headingDegrees, set: (item, value) => { item.headingDegrees = ((value % 360) + 360) % 360; } }
};

const flightClimb = {
  label: 'Climb',
  read: item => (item.climbDegrees + 90) / 180,
  write: (item, t) => { item.climbDegrees = Math.round(t * 180 - 90); },
  show: item => `${item.climbDegrees}°`,
  entry: { unit: '°', get: item => item.climbDegrees, set: (item, value) => { item.climbDegrees = value; } }
};

const flightAcceleration = {
  label: 'Acceleration',
  read: item => (item.accelerationMetresPerSecondSquared + 50) / 150,
  write: (item, t) => { item.accelerationMetresPerSecondSquared = Math.round(t * 150 - 50); },
  show: item => `${item.accelerationMetresPerSecondSquared} m/s²`,
  entry: { unit: 'm/s²', get: item => item.accelerationMetresPerSecondSquared, set: (item, value) => { item.accelerationMetresPerSecondSquared = value; } }
};

const flightTurn = {
  label: 'Turn',
  read: item => (item.turnDegreesPerSecond + 10) / 20,
  write: (item, t) => { item.turnDegreesPerSecond = +(t * 20 - 10).toFixed(1); },
  show: item => `${item.turnDegreesPerSecond}°/s`,
  entry: { unit: '°/s', get: item => item.turnDegreesPerSecond, set: (item, value) => { item.turnDegreesPerSecond = value; } }
};

const flightTime = {
  label: 'Flight time',
  read: item => clamp01(logPosition(item.durationSeconds, [1, 600])),
  write: (item, t) => { item.durationSeconds = Math.max(1, Math.round(logValue(t, [1, 600]))); },
  show: item => `${item.durationSeconds} s`,
  entry: { unit: 's', get: item => item.durationSeconds, set: (item, value) => { item.durationSeconds = value; } }
};

const formationCount = {
  label: 'Aircraft',
  read: item => (item.memberCount - 1) / 23,
  write: (item, t) => { item.memberCount = 1 + Math.round(t * 23); },
  show: item => String(item.memberCount),
  steps: 23,
  entry: { integer: true, get: item => item.memberCount, set: (item, value) => { item.memberCount = value; } }
};

const meteorSpeed = {
  label: 'Speed',
  read: item => (item.speedKilometresPerSecond - 11) / 61,
  write: (item, t) => { item.speedKilometresPerSecond = Math.round(11 + t * 61); },
  show: item => `${item.speedKilometresPerSecond} km/s`,
  entry: { unit: 'km/s', get: item => item.speedKilometresPerSecond, set: (item, value) => { item.speedKilometresPerSecond = value; } }
};

const meteorDiameter = {
  label: 'Diameter',
  read: item => clamp01(logPosition(item.diameterMetres, [.001, 50])),
  write: (item, t) => { item.diameterMetres = +logValue(t, [.001, 50]).toPrecision(2); },
  show: item => metres(item.diameterMetres),
  entry: { units: 'metres', get: item => item.diameterMetres, set: (item, value) => { item.diameterMetres = value; } }
};

const meteorEntry = {
  label: 'Entry angle',
  read: item => (item.entryDegrees - 5) / 85,
  write: (item, t) => { item.entryDegrees = Math.round(5 + t * 85); },
  show: item => `${item.entryDegrees}°`,
  entry: { unit: '°', get: item => item.entryDegrees, set: (item, value) => { item.entryDegrees = value; } }
};

const meteorEnd = {
  label: 'End height',
  read: item => clamp01(item.endHeightMetres / Math.max(1, item.startMetres.z)),
  write: (item, t) => { item.endHeightMetres = Math.min(item.startMetres.z - 1000, Math.round(t * item.startMetres.z / 100) * 100); },
  show: item => metres(item.endHeightMetres),
  entry: { units: 'metres', get: item => item.endHeightMetres, set: (item, value) => { item.endHeightMetres = value; } }
};

const showerCount = {
  label: 'Meteors',
  read: item => clamp01(logPosition(item.meteorCount, [1, 200])),
  write: (item, t) => { item.meteorCount = Math.max(1, Math.round(logValue(t, [1, 200]))); },
  show: item => String(item.meteorCount),
  entry: { integer: true, get: item => item.meteorCount, set: (item, value) => { item.meteorCount = value; } }
};

const showerSize = {
  label: 'Size',
  read: item => clamp01(logPosition(Math.max(1000, item.radiusMetres), [1000, 30000])),
  write: (item, t) => { item.radiusMetres = Math.round(logValue(t, [1000, 30000])); },
  show: item => `${metres(item.radiusMetres)} radius`,
  entry: { units: 'metres', get: item => item.radiusMetres, set: (item, value) => { item.radiusMetres = value; } }
};

const whipMach = {
  label: 'Tip speed',
  read: item => clamp01((item.mach - range('whipMach')[0]) / (range('whipMach')[1] - range('whipMach')[0])),
  write: (item, t) => { const [low, high] = range('whipMach'); item.mach = +(low + t * (high - low)).toFixed(2); },
  show: item => `Mach ${item.mach.toFixed(2)}`,
  entry: { get: item => item.mach, set: (item, value) => { item.mach = value; } }
};

const whipHeight = {
  label: 'Height',
  read: item => clamp01(logPosition(Math.max(.1, item.startMetres.z), [.1, 10])),
  write: (item, t) => { item.startMetres = { ...item.startMetres, z: +logValue(t, [.1, 10]).toPrecision(2) }; },
  show: item => metres(item.startMetres.z),
  entry: { units: 'metres', get: item => item.startMetres.z, set: (item, value) => { item.startMetres = { ...item.startMetres, z: value }; } }
};

const whipCracker = {
  label: 'Cracker',
  read: item => clamp01(logPosition(item.crackerLengthMetres, range('crackerLengthMetres'))),
  write: (item, t) => { item.crackerLengthMetres = +logValue(t, range('crackerLengthMetres')).toPrecision(2); },
  show: item => metres(item.crackerLengthMetres),
  entry: { units: 'metres', get: item => item.crackerLengthMetres, set: (item, value) => { item.crackerLengthMetres = value; } }
};

/** Macro sliders for an emitter, in display order. */
export function macrosFor(emitter) {
  if (emitter.kind === 'lightning') return [energy, height, branching, jaggedness, crack, strokes];
  if (emitter.kind === 'storm') return [stormSize, stormDuration, stormFlashes, stormGround, stormCloud, energy, branching, crack];
  if (emitter.kind === 'meteor') return [meteorSpeed, meteorDiameter, meteorEntry, flightHeight, flightHeading, meteorEnd];
  if (emitter.kind === 'shower') return [showerCount, showerSize, stormDuration, meteorSpeed, meteorDiameter, meteorEntry];
  if (emitter.kind === 'formation') return [formationCount, machNumber, flightHeight, flightHeading, flightClimb, flightAcceleration, flightTurn, flightTime];
  if (emitter.kind === 'whip') return [whipMach, whipHeight, flightHeading, flightClimb, whipCracker];
  if (emitter.kind === 'flight') return [machNumber, flightHeight, flightHeading, flightClimb, flightAcceleration, flightTurn, flightTime];
  if (emitter.kind === 'barrage') return [barrageSize, stormDuration, barrageRounds, barrageSalvo, charge, fireball];
  return [charge, blastHeight, fireball];
}
