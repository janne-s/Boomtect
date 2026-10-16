import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, TRAJECTORY, VIEW } from './constants.js';
import { temperatureAtHeightKelvin } from './air.js';
import { localProfile, speedAt, wavefront } from './refraction.js';

const CONE_RING = Object.freeze(Array.from({ length: VIEW.cone.ringPoints }, (_, step) => {
  const angle = 2 * Math.PI * step / VIEW.cone.ringPoints;
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

export function machCone(path, now, profile) {
  const count = path.seconds.length;
  const last = Math.min(count - 1, Math.floor((now - path.seconds[0]) / path.step));
  if (last < 1) return null;
  const at = index => ({ x: path.x[index], y: path.y[index], z: path.z[index] });
  const speedAround = index => {
    const from = Math.max(0, index - 1);
    const to = Math.min(count - 1, index + 1);
    return Math.hypot(path.x[to] - path.x[from], path.y[to] - path.y[from], path.z[to] - path.z[from]) / ((to - from) * path.step);
  };
  const supersonic = index => speedAround(index) > speedAt(localProfile(profile, path.z[index]), path.z[index]);
  let end = last;
  while (end > 0 && !supersonic(end)) end -= 1;
  if (end < 1) return null;
  const flying = (now - path.seconds[0]) / path.step <= count - 1;
  const apex = flying && end === last;
  const rings = [];
  const radii = [];
  for (let ring = apex ? 1 : 0; ring <= VIEW.cone.rings; ring += 1) {
    const index = Math.round(end * (1 - ring / VIEW.cone.rings));
    const before = at(Math.max(0, index - 1));
    const after = at(Math.min(count - 1, index + 1));
    const span = (Math.min(count - 1, index + 1) - Math.max(0, index - 1)) * path.step;
    const d = { x: after.x - before.x, y: after.y - before.y, z: after.z - before.z };
    const length = Math.hypot(d.x, d.y, d.z);
    const point = at(index);
    const local = localProfile(profile, point.z);
    const cosine = speedAt(local, point.z) / (length / span);
    if (!(length > 0 && cosine < 1)) continue;
    const unit = { x: d.x / length, y: d.y / length, z: d.z / length };
    const across = Math.abs(unit.z) < .9 ? { x: unit.y, y: -unit.x, z: 0 } : { x: 0, y: unit.z, z: -unit.y };
    const norm = Math.hypot(across.x, across.y, across.z);
    const first = { x: across.x / norm, y: across.y / norm, z: across.z / norm };
    const second = { x: unit.y * first.z - unit.z * first.y, y: unit.z * first.x - unit.x * first.z, z: unit.x * first.y - unit.y * first.x };
    const { centre, radiusMetres } = wavefront(local, point, now - path.seconds[index]);
    const middle = { x: centre.x + radiusMetres * cosine * unit.x, y: centre.y + radiusMetres * cosine * unit.y, z: centre.z + radiusMetres * cosine * unit.z };
    const radius = radiusMetres * Math.sqrt(1 - cosine * cosine);
    radii.push(radiusMetres);
    rings.push(CONE_RING.map(({ cos, sin }) => {
      const a = radius * cos;
      const b = radius * sin;
      return { x: middle.x + a * first.x + b * second.x, y: middle.y + a * first.y + b * second.y, z: middle.z + a * first.z + b * second.z };
    }));
  }
  if (!rings.length) return null;
  return { apex: apex ? at(last) : null, rings, radii };
}
