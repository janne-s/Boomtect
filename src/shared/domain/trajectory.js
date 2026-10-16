import { GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, TRAJECTORY } from './constants.js';
import { temperatureAtHeightKelvin } from './air.js';

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
