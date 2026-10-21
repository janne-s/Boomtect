import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, TRAJECTORY, VIEW } from './constants.js';
import { temperatureAtHeightKelvin } from './air.js';
import { localProfile, speedAt, wavefront } from './refraction.js';

const CONE_RING = Object.freeze(Array.from({ length: VIEW.cone.ringPoints }, (_, step) => {
  const angle = 2 * Math.PI * step / VIEW.cone.ringPoints;
  return Object.freeze({ cos: Math.cos(angle), sin: Math.sin(angle) });
}));
const ENVELOPE_RING = Object.freeze(Array.from({ length: 2 * VIEW.cone.ringPoints }, (_, step) => {
  const angle = Math.PI * step / VIEW.cone.ringPoints;
  return Object.freeze({ cos: Math.cos(angle), sin: Math.sin(angle) });
}));

export const soundSpeedAt = (air, heightMetres) => Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(air, air.refraction ? heightMetres : 0));

export function flightPath(flight, air) {
  const steps = Math.min(TRAJECTORY.maximumSteps, Math.max(2, Math.ceil(flight.durationSeconds / TRAJECTORY.stepSeconds)));
  const step = flight.durationSeconds / steps;
  const climb = flight.climbDegrees * Math.PI / 180;
  const path = { seconds: [], x: [], y: [], z: [], vx: [], vy: [], vz: [], speed: [], step };
  let { x, y, z } = flight.startMetres;
  let speed = flight.mach * soundSpeedAt(air, z);
  for (let index = 0; index <= steps; index += 1) {
    const t = index * step;
    const heading = (flight.headingDegrees + flight.turnDegreesPerSecond * t) * Math.PI / 180;
    const vx = speed * Math.cos(climb) * Math.sin(heading);
    const vy = speed * Math.cos(climb) * Math.cos(heading);
    const vz = speed * Math.sin(climb);
    path.seconds.push(flight.startSeconds + t); path.x.push(x); path.y.push(y); path.z.push(z);
    path.vx.push(vx); path.vy.push(vy); path.vz.push(vz); path.speed.push(speed);
    x += vx * step; y += vy * step; z += vz * step;
    speed += flight.accelerationMetresPerSecondSquared * step;
    if (z < 0 || speed < TRAJECTORY.stoppedMetresPerSecond) break;
  }
  return path;
}

export function withApproach(path, air) {
  const speed = path.speed[0];
  const mach = speed / soundSpeedAt(air, path.z[0]);
  if (!(mach > 1)) return path;
  const metres = TRAJECTORY.approachHeights * Math.max(0, path.z[0]) / Math.sqrt(mach * mach - 1) + TRAJECTORY.approachMetres;
  const steps = Math.min(TRAJECTORY.maximumSteps, Math.ceil(metres / speed / path.step));
  const approach = { seconds: [], x: [], y: [], z: [], vx: [], vy: [], vz: [], speed: [], step: path.step };
  for (let index = steps; index >= 1; index -= 1) {
    const t = index * path.step;
    approach.seconds.push(path.seconds[0] - t);
    approach.x.push(path.x[0] - path.vx[0] * t); approach.y.push(path.y[0] - path.vy[0] * t); approach.z.push(path.z[0] - path.vz[0] * t);
    approach.vx.push(path.vx[0]); approach.vy.push(path.vy[0]); approach.vz.push(path.vz[0]); approach.speed.push(speed);
  }
  for (const key of ['seconds', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'speed']) approach[key].push(...path[key]);
  return approach;
}

const CONE_TURN_RADIANS = 15 * Math.PI / 180;
const MOST_CONE_RINGS = 64;
const turns = new WeakMap();
const powerOfTwoAbove = value => 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, value))));

function largestTurn(path) {
  if (turns.has(path)) return turns.get(path);
  const along = (index, axis) => path[axis][index + 1] - path[axis][index];
  let turn = 0;
  for (let index = 1; index < path.seconds.length - 1; index += 1) {
    const [ax, ay, az, bx, by, bz] = [along(index - 1, 'x'), along(index - 1, 'y'), along(index - 1, 'z'), along(index, 'x'), along(index, 'y'), along(index, 'z')];
    const cosine = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz) || 1);
    turn = Math.max(turn, Math.acos(Math.max(-1, Math.min(1, cosine))));
  }
  turns.set(path, turn);
  return turn;
}

/**
 * Rings sit on a grid of the path whose spacing is a power of two in samples, so that each keeps its emission
 * point as the cone grows and the grid changes only when the flight so far doubles; a turn takes them closer.
 */
function coneStride(path, end) {
  const turn = largestTurn(path);
  const even = 2 ** Math.max(0, Math.floor(Math.log2(Math.max(1, end / VIEW.cone.rings))));
  const turning = turn > 0 ? 2 ** Math.floor(Math.log2(Math.max(1, CONE_TURN_RADIANS / turn))) : even;
  return Math.max(powerOfTwoAbove(end / MOST_CONE_RINGS), Math.min(even, turning));
}

export function machCone(path, now, profile, { profileAt = localProfile, envelope = false } = {}) {
  const count = path.seconds.length;
  const last = Math.min(count - 1, Math.floor((now - path.seconds[0]) / path.step));
  if (last < 1) return null;
  const at = index => ({ x: path.x[index], y: path.y[index], z: path.z[index] });
  const speedAround = index => {
    const from = Math.max(0, index - 1);
    const to = Math.min(count - 1, index + 1);
    return Math.hypot(path.x[to] - path.x[from], path.y[to] - path.y[from], path.z[to] - path.z[from]) / ((to - from) * path.step);
  };
  const supersonic = index => speedAround(index) > speedAt(profileAt(profile, path.z[index]), path.z[index]);
  const fronts = new Map();
  const frontAt = index => {
    if (fronts.has(index)) return fronts.get(index);
    const point = at(index);
    const age = now - path.seconds[index];
    const front = wavefront(profileAt(profile, point.z), point, age);
    if (envelope && profile.wind) {
      front.centre = { ...front.centre, x: front.centre.x + (profile.wind.x + profile.shear.x * point.z) * age, y: front.centre.y + (profile.wind.y + profile.shear.y * point.z) * age };
    }
    fronts.set(index, front);
    return front;
  };
  let end = last;
  while (end > 0 && !supersonic(end)) end -= 1;
  if (end < 1) return null;
  const flying = (now - path.seconds[0]) / path.step <= count - 1;
  const apex = flying && end === last;
  const rings = [];
  const radii = [];
  const stride = coneStride(path, end);
  const indices = [];
  if (!apex) indices.push(end);
  for (let index = Math.floor(end / stride) * stride; index >= 0; index -= stride) if (index !== end) indices.push(index);
  for (const index of indices) {
    const before = at(Math.max(0, index - 1));
    const after = at(Math.min(count - 1, index + 1));
    const span = (Math.min(count - 1, index + 1) - Math.max(0, index - 1)) * path.step;
    let d = { x: after.x - before.x, y: after.y - before.y, z: after.z - before.z };
    let length = Math.hypot(d.x, d.y, d.z);
    const point = at(index);
    const local = profileAt(profile, point.z);
    let cosine = speedAt(local, point.z) / (length / span);
    if (envelope) {
      const left = frontAt(Math.max(0, index - 1));
      const right = frontAt(Math.min(count - 1, index + 1));
      d = { x: right.centre.x - left.centre.x, y: right.centre.y - left.centre.y, z: right.centre.z - left.centre.z };
      length = Math.hypot(d.x, d.y, d.z);
      // Sphere-envelope tangency: (x − centre) · centre' = −radius · radius'.
      cosine = (left.radiusMetres - right.radiusMetres) / length;
    }
    if (!(length > 0 && Math.abs(cosine) < 1)) continue;
    const unit = { x: d.x / length, y: d.y / length, z: d.z / length };
    const across = Math.abs(unit.z) < .9 ? { x: unit.y, y: -unit.x, z: 0 } : { x: 0, y: unit.z, z: -unit.y };
    const norm = Math.hypot(across.x, across.y, across.z);
    const first = { x: across.x / norm, y: across.y / norm, z: across.z / norm };
    const second = { x: unit.y * first.z - unit.z * first.y, y: unit.z * first.x - unit.x * first.z, z: unit.x * first.y - unit.y * first.x };
    const { centre, radiusMetres } = frontAt(index);
    const middle = { x: centre.x + radiusMetres * cosine * unit.x, y: centre.y + radiusMetres * cosine * unit.y, z: centre.z + radiusMetres * cosine * unit.z };
    const radius = radiusMetres * Math.sqrt(1 - cosine * cosine);
    radii.push(radiusMetres);
    rings.push((envelope ? ENVELOPE_RING : CONE_RING).map(({ cos, sin }) => {
      const a = radius * cos;
      const b = radius * sin;
      return { x: middle.x + a * first.x + b * second.x, y: middle.y + a * first.y + b * second.y, z: middle.z + a * first.z + b * second.z };
    }));
  }
  if (!rings.length) return null;
  return { apex: apex ? at(last) : null, rings, radii, ...(envelope ? { lineEvery: 2 * VIEW.cone.lineEvery } : {}) };
}

/**
 * Class C as a pattern: a V behind the leader, members alternating left and right of its heading, each rank
 * `lateralSpacingMetres` aside and `trailSpacingMetres` back, at the leader's height. Each member keeps the leader's
 * fields with its own id `<leader id>:<index>`; the leader is member 0.
 */
export function formationMembers(leader, count, lateralSpacingMetres, trailSpacingMetres) {
  const heading = leader.headingDegrees * Math.PI / 180;
  const across = { x: Math.cos(heading), y: -Math.sin(heading) };
  const along = { x: Math.sin(heading), y: Math.cos(heading) };
  return Array.from({ length: count }, (_, index) => {
    const rank = Math.ceil(index / 2);
    const side = index % 2 ? 1 : -1;
    const lateral = side * rank * lateralSpacingMetres;
    const back = rank * trailSpacingMetres;
    return {
      ...leader,
      id: `${leader.id}:${index}`,
      startMetres: {
        x: leader.startMetres.x + across.x * lateral - along.x * back,
        y: leader.startMetres.y + across.y * lateral - along.y * back,
        z: leader.startMetres.z
      }
    };
  });
}
