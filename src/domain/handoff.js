/**
 * The handoff between tects: one sound with where and how it was heard, so that another tect can
 * take it up in the same place (Doc/design/architecture-decision-5-tect-handoff.md). Shared by the
 * family, so it holds no Boomtect terms: positions are metres east, north, and above the ground from
 * the place's geographic point, angles are compass degrees clockwise from north, elevation upward.
 *
 * It is read like a scene: a missing field takes its default, an unknown one is dropped, a number
 * outside its range is brought into it, and the version is recorded, never a reason to refuse. Only
 * what is not a handoff, or whose content is broken, is refused.
 */
export const HANDOFF_FORMAT = 'tect.handoff';
export const HANDOFF_VERSION = 1;
/** A sound heard at a listener; 'source' is kept for a directional source a tect emits. */
export const HANDOFF_KINDS = Object.freeze(['sound', 'source']);
/**
 * What the receiving tect may move to fit the sound: its listener to where the sound was heard and
 * its source the way it came from, only its source, or nothing, keeping a scene already set up.
 */
export const HANDOFF_PLACEMENTS = Object.freeze(['listener-and-source', 'source', 'none']);
const RELIABILITY_CLASSES = Object.freeze(['A', 'B', 'C']);
const TEXT_LENGTH = 120;
const LIST_LENGTH = 32;

const RANGES = Object.freeze({
  latitudeDegrees: [-90, 90],
  longitudeDegrees: [-180, 180],
  datumMetres: [-500, 9000],
  temperatureCelsius: [-60, 60],
  relativeHumidityPercent: [0, 100],
  pressureKpa: [30, 110],
  positionMetres: [-1e6, 1e6],
  heightAboveGroundMetres: [0, 1e5],
  headingDegrees: [0, 360],
  pitchDegrees: [-90, 90],
  azimuthDegrees: [0, 360],
  elevationDegrees: [-90, 90],
  distanceMetres: [0, 1e7],
  sampleRateHz: [8000, 384000],
  channels: [1, 64],
  fullScalePa: [1e-6, 1e6],
  startSeconds: [-1e6, 1e6]
});

export class HandoffError extends Error {}

function check(condition, message) {
  if (!condition) throw new HandoffError(message);
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function number(value, key, path, fallback) {
  if (value === undefined) {
    check(fallback !== undefined, `${path} is missing.`);
    return fallback;
  }
  check(typeof value === 'number' && Number.isFinite(value), `${path} must be a number.`);
  const [minimum, maximum] = RANGES[key];
  return Math.min(maximum, Math.max(minimum, value));
}

function text(value, path, fallback = '') {
  if (value === undefined || value === null) return fallback;
  check(typeof value === 'string', `${path} must be a text.`);
  return value.slice(0, TEXT_LENGTH);
}

function texts(value, path) {
  if (value === undefined) return [];
  check(Array.isArray(value), `${path} must be a list.`);
  return value.slice(0, LIST_LENGTH).map((item, index) => text(item, `${path}[${index}]`));
}

/** Null when absent: the receiving tect uses its own. */
function optional(value, path, read) {
  if (value === undefined || value === null) return null;
  check(isRecord(value), `${path} must be an object or null.`);
  return read(value);
}

const place = value => ({
  name: text(value.name, 'place.name'),
  latitudeDegrees: number(value.latitudeDegrees, 'latitudeDegrees', 'place.latitudeDegrees'),
  longitudeDegrees: number(value.longitudeDegrees, 'longitudeDegrees', 'place.longitudeDegrees'),
  // Sea level height of the ground at the point, when known.
  datumMetres: value.datumMetres === null ? null : number(value.datumMetres, 'datumMetres', 'place.datumMetres', null)
});

const air = value => ({
  temperatureCelsius: number(value.temperatureCelsius, 'temperatureCelsius', 'air.temperatureCelsius', 15),
  relativeHumidityPercent: number(value.relativeHumidityPercent, 'relativeHumidityPercent', 'air.relativeHumidityPercent', 70),
  pressureKpa: number(value.pressureKpa, 'pressureKpa', 'air.pressureKpa', 101.325)
});

function listener(value) {
  const position = value.positionMetres ?? {};
  check(isRecord(position), 'listener.positionMetres must be an object.');
  return {
    positionMetres: {
      east: number(position.east, 'positionMetres', 'listener.positionMetres.east', 0),
      north: number(position.north, 'positionMetres', 'listener.positionMetres.north', 0)
    },
    heightAboveGroundMetres: number(value.heightAboveGroundMetres, 'heightAboveGroundMetres', 'listener.heightAboveGroundMetres', 0),
    headingDegrees: number(value.headingDegrees, 'headingDegrees', 'listener.headingDegrees', 0),
    pitchDegrees: number(value.pitchDegrees, 'pitchDegrees', 'listener.pitchDegrees', 0)
  };
}

/** Where the sound comes from at the listener, and how far its source is: one direction for what may arrive from many. */
const arrival = value => ({
  azimuthDegrees: number(value.azimuthDegrees, 'azimuthDegrees', 'arrival.azimuthDegrees'),
  elevationDegrees: number(value.elevationDegrees, 'elevationDegrees', 'arrival.elevationDegrees', 0),
  distanceMetres: value.distanceMetres === null ? null : number(value.distanceMetres, 'distanceMetres', 'arrival.distanceMetres', null)
});

function audio(value) {
  check(isRecord(value), 'audio is missing.');
  return {
    sampleRateHz: Math.round(number(value.sampleRateHz, 'sampleRateHz', 'audio.sampleRateHz')),
    channels: Math.round(number(value.channels, 'channels', 'audio.channels')),
    // What the channels hold: 'pressure' (one omni microphone), 'binaural', or 'ambix'.
    layout: text(value.layout, 'audio.layout', 'pressure'),
    sampleFormat: text(value.sampleFormat, 'audio.sampleFormat', 'ieee-float32'),
    // The pressure in pascals that a sample of 1 stands for.
    fullScalePa: number(value.fullScalePa, 'fullScalePa', 'audio.fullScalePa'),
    // When the first sample is, from the event's start.
    startSeconds: number(value.startSeconds, 'startSeconds', 'audio.startSeconds', 0),
    file: value.file === undefined || value.file === null ? null : text(value.file, 'audio.file')
  };
}

/** Reads a handoff of any version and returns a complete copy, or throws HandoffError. */
export function readHandoff(value) {
  check(isRecord(value) && value.format === HANDOFF_FORMAT, 'This is not a tect handoff.');
  const producer = value.producer ?? {};
  check(isRecord(producer), 'producer must be an object.');
  const content = value.content ?? {};
  check(isRecord(content), 'content must be an object.');
  return {
    format: HANDOFF_FORMAT,
    version: HANDOFF_VERSION,
    id: text(value.id, 'id'),
    producer: { app: text(producer.app, 'producer.app'), version: text(producer.version, 'producer.version'), modelVersion: text(producer.modelVersion, 'producer.modelVersion') },
    // A kind this tect does not know is kept for the receiver to set aside.
    kind: text(value.kind, 'kind', 'sound'),
    name: text(value.name, 'name'),
    createdAt: text(value.createdAt, 'createdAt'),
    place: optional(value.place, 'place', place),
    air: optional(value.air, 'air', air),
    listener: optional(value.listener, 'listener', listener) ?? listener({}),
    arrival: optional(value.arrival, 'arrival', arrival),
    // Without its own choice, a handoff with a place moves both, and one without moves the source.
    placement: HANDOFF_PLACEMENTS.includes(value.placement) ? value.placement : value.place ? 'listener-and-source' : 'source',
    audio: audio(value.audio),
    // Which parts of the propagation the sound holds, and which it leaves to the receiver.
    content: { includes: texts(content.includes, 'content.includes'), excludes: texts(content.excludes, 'content.excludes') },
    reliability: RELIABILITY_CLASSES.includes(value.reliability) ? value.reliability : 'C'
  };
}

export const serializeHandoff = handoff => `${JSON.stringify(readHandoff(handoff), null, 2)}\n`;

/**
 * Window messages between two open tects (Doc/design/architecture-decision-5-tect-handoff.md, part 5).
 * The receiver says it is ready when it loads with an opener and whenever it is greeted; the sender
 * then posts the handoff with its samples, and the receiver answers that it took or refused it.
 * Each side checks the other's origin against its own list before reading anything.
 */
export const TECT_MESSAGES = Object.freeze({ hello: 'tect.hello', ready: 'tect.ready', handoff: 'tect.handoff', received: 'tect.received', refused: 'tect.refused' });

/** A handoff with its sound, one Float32Array of interleaved samples at the handoff's full scale. */
export const handoffMessage = (handoff, samples) => ({ type: TECT_MESSAGES.handoff, handoff: readHandoff(handoff), samples });

/** Reads a handoff message: its handoff and its samples, which must fill whole frames; or throws HandoffError. */
export function readHandoffMessage(data) {
  check(isRecord(data) && data.type === TECT_MESSAGES.handoff, 'This is not a tect handoff message.');
  const handoff = readHandoff(data.handoff);
  const { samples } = data;
  check(samples instanceof Float32Array && samples.length > 0 && samples.length % handoff.audio.channels === 0, 'The handoff message must carry whole frames of 32-bit float samples.');
  return { handoff, samples };
}
