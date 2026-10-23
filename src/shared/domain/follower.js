import { TRAJECTORY } from './constants.js';
const SAVED_STEP_SECONDS = .25;
const MOST_PATHS = 64;
const MOST_POINTS = 4000;
const TEXT_LENGTH = 64;
const AXES = Object.freeze(['x', 'y', 'z', 'vx', 'vy', 'vz']);
const tenth = value => Math.round(value * 10) / 10;

/** A path kept with a follower: every sample about `SAVED_STEP_SECONDS` apart, to a tenth of a metre and metre per second. */
export function savedPath(path) {
  const stride = Math.max(1, Math.round(SAVED_STEP_SECONDS / path.step));
  const count = Math.floor((path.x.length - 1) / stride) + 1;
  return {
    startSeconds: path.seconds[0],
    stepSeconds: path.step * stride,
    ...Object.fromEntries(AXES.map(axis => [axis, Array.from({ length: count }, (_, index) => tenth(path[axis][index * stride]))]))
  };
}

/** A saved path as the frames sample one, filled in linearly to `TRAJECTORY.stepSeconds` so that motion and cones run as smoothly as on the own paths. */
export function followedPath(saved) {
  const factor = Math.max(1, Math.round(saved.stepSeconds / TRAJECTORY.stepSeconds));
  const step = saved.stepSeconds / factor;
  const count = (saved.x.length - 1) * factor + 1;
  const filled = values => Float64Array.from({ length: count }, (_, index) => {
    const at = Math.floor(index / factor);
    const share = index / factor - at;
    return share > 0 ? values[at] + (values[at + 1] - values[at]) * share : values[at];
  });
  const path = { seconds: Array.from({ length: count }, (_, index) => saved.startSeconds + index * step), step };
  for (const axis of AXES) path[axis] = Array.from(filled(saved[axis]));
  path.speed = path.vx.map((value, index) => Math.hypot(value, path.vy[index], path.vz[index]));
  return path;
}

const text = value => (typeof value === 'string' && value.length > 0 ? value.slice(0, TEXT_LENGTH) : null);

function readPath(value) {
  if (!value || typeof value !== 'object') return null;
  const { startSeconds, stepSeconds } = value;
  if (!Number.isFinite(startSeconds) || !(stepSeconds > 0) || !Number.isFinite(stepSeconds)) return null;
  const count = Array.isArray(value.x) ? Math.min(value.x.length, MOST_POINTS) : 0;
  if (count < 2) return null;
  const path = { startSeconds, stepSeconds };
  for (const axis of AXES) {
    const values = value[axis];
    if (!Array.isArray(values) || values.length < count || !values.slice(0, count).every(Number.isFinite)) return null;
    path[axis] = values.slice(0, count);
  }
  return path;
}

/** Class C. A follower's link to the emitter it follows and that emitter's paths; none when either is missing or broken. */
export function followerFields(value) {
  const follows = value.follows;
  if (!follows || typeof follows !== 'object') return {};
  const app = text(follows.app);
  const id = text(follows.id);
  const paths = (Array.isArray(value.paths) ? value.paths.slice(0, MOST_PATHS) : []).map(readPath).filter(Boolean);
  if (!app || !id || !paths.length) return {};
  return { follows: { app, id, name: text(follows.name) ?? id }, paths };
}

/** Where and when a follower's first path starts, its heading and climb there, how long it lasts, and its top speed. */
export function followerPlacement(saved) {
  const [vx, vy, vz] = [saved.vx[0], saved.vy[0], saved.vz[0]];
  const ground = Math.hypot(vx, vy);
  return {
    startMetres: { x: saved.x[0], y: saved.y[0], z: Math.max(0, saved.z[0]) },
    startSeconds: saved.startSeconds,
    headingDegrees: ground > 0 ? ((Math.atan2(vx, vy) * 180 / Math.PI) + 360) % 360 : 0,
    climbDegrees: Math.atan2(vz, ground) * 180 / Math.PI,
    durationSeconds: (saved.x.length - 1) * saved.stepSeconds,
    topSpeedMetresPerSecond: Math.max(...saved.vx.map((value, index) => Math.hypot(value, saved.vy[index], saved.vz[index])))
  };
}

/** A seed from the followed emitter's id, so that a follower made again sounds the same. */
export function followerSeed(app, id) {
  let hash = 0x811c9dc5;
  for (const character of `${app}:${id}`) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return hash >>> 0;
}
