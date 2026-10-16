import { FLIGHT, GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, UPPER_AIR } from './constants.js';
import { airAtHeight, atmosphericAbsorptionNepersPerMetre, pressureAtHeightPa, temperatureAtHeightKelvin } from '../shared/domain/air.js';
import { carlsonBoom } from './flight.js';

/** Air class B/C, wind class C, rays class A on that profile, pressure class C (Rickley & Pierce 1980, FAA-EE-80-22). */

const C_FACTOR = GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN;

/** US Standard Atmosphere 1976 above 20 km. */
const US76 = Object.freeze([
  [20000, 216.65, .001],
  [32000, 228.65, .0028],
  [47000, 270.65, 0],
  [51000, 270.65, -.0028],
  [71000, 214.65, -.002]
]);
const TROPOPAUSE_KELVIN = 216.65;

function upperWarmingKelvin(heightMetres) {
  let warming = 0;
  for (const [base, kelvin, rise] of US76) {
    if (heightMetres <= base) break;
    warming = kelvin + rise * (heightMetres - base) - TROPOPAUSE_KELVIN;
  }
  return warming;
}

export const upperTemperatureKelvin = (air, heightMetres) => temperatureAtHeightKelvin(air, heightMetres) + upperWarmingKelvin(heightMetres);

function upperWind(air, heightMetres) {
  const toward = degrees => [-Math.sin(degrees * Math.PI / 180), -Math.cos(degrees * Math.PI / 180)];
  const [gx, gy] = toward(air.windFromDegrees);
  const lower = air.windSpeedMetresPerSecond + air.windShearPerSecond * Math.min(heightMetres, air.tropopauseMetres);
  const [jx, jy] = toward(air.upperWindFromDegrees);
  const jet = air.upperWindMetresPerSecond * Math.exp(-(((heightMetres - UPPER_AIR.jetHeightMetres) / UPPER_AIR.jetWidthMetres) ** 2));
  return [gx * lower + jx * jet, gy * lower + jy * jet];
}

const LEVELS = Math.round(UPPER_AIR.topMetres / UPPER_AIR.stepMetres) + 1;

function effectiveSpeeds(air, nx, ny) {
  return Float64Array.from({ length: LEVELS }, (_, level) => {
    const height = level * UPPER_AIR.stepMetres;
    const [ux, uy] = upperWind(air, height);
    return Math.sqrt(C_FACTOR * upperTemperatureKelvin(air, height)) + ux * nx + uy * ny;
  });
}

function speedOn(speeds, heightMetres) {
  const at = Math.min(LEVELS - 1.000001, Math.max(0, heightMetres / UPPER_AIR.stepMetres));
  const level = Math.floor(at);
  return speeds[level] + (speeds[level + 1] - speeds[level]) * (at - level);
}

function leg(speeds, alphaAt, q, low, top) {
  let range = 0;
  let seconds = 0;
  let metres = 0;
  let nepers = 0;
  const step = UPPER_AIR.stepMetres;
  for (let z1 = low; z1 < top - 1e-9;) {
    const z2 = Math.min(top, (Math.floor(z1 / step + 1e-9) + 1) * step);
    const c1 = speedOn(speeds, z1);
    const c2 = Math.min(1 / q, speedOn(speeds, z2));
    const s1 = Math.sqrt(Math.max(0, 1 - q * q * c1 * c1));
    const s2 = Math.sqrt(Math.max(0, 1 - q * q * c2 * c2));
    const dz = z2 - z1;
    const g = (c2 - c1) / dz;
    let pieceMetres;
    if (Math.abs(g) * dz < 1e-9 * c1) {
      range += dz * q * c1 / s1;
      seconds += dz / (c1 * s1);
      pieceMetres = dz / s1;
    } else {
      range += (s1 - s2) / (g * q);
      seconds += Math.log(c2 * (1 + s1) / (c1 * (1 + s2))) / g;
      pieceMetres = (Math.asin(Math.min(1, q * c2)) - Math.asin(Math.min(1, q * c1))) / (g * q);
    }
    metres += pieceMetres;
    nepers += pieceMetres * alphaAt((z1 + z2) / 2);
    z1 = z2;
  }
  return { range, seconds, metres, nepers };
}

function rayTable(air, nx, ny, zs, zr, alphaAt, rays = UPPER_AIR.rays) {
  const speeds = effectiveSpeeds(air, nx, ny);
  const low = Math.min(zs, zr);
  const high = Math.max(zs, zr);
  let limit = 0;
  for (let level = 0; level < LEVELS; level += 1) {
    const height = level * UPPER_AIR.stepMetres;
    if (height >= low && height <= high) limit = Math.max(limit, speeds[level]);
  }
  limit = Math.max(limit, speedOn(speeds, low), speedOn(speeds, high));
  let ceiling = 0;
  for (let level = 0; level < LEVELS; level += 1) if (level * UPPER_AIR.stepMetres > high) ceiling = Math.max(ceiling, speeds[level]);
  const rows = [];
  if (!(ceiling > limit)) return rows;
  for (let ray = 0; ray < rays; ray += 1) {
    const share = ((ray + .5) / rays) ** 2;
    const phase = limit + (ceiling - limit) * share;
    const q = 1 / phase;
    let top = NaN;
    for (let level = Math.floor(high / UPPER_AIR.stepMetres); level < LEVELS - 1; level += 1) {
      const z1 = Math.max(high, level * UPPER_AIR.stepMetres);
      const z2 = (level + 1) * UPPER_AIR.stepMetres;
      const c1 = speedOn(speeds, z1);
      const c2 = speeds[level + 1];
      if (c2 >= phase) { top = c2 > c1 ? z1 + (phase - c1) / (c2 - c1) * (z2 - z1) : z1; break; }
    }
    // Rays the troposphere's own wind turns back are the primary boom's (`stationaryArrivals`).
    if (!(top > air.tropopauseMetres)) continue;
    const up = leg(speeds, alphaAt, q, zs, top);
    const down = leg(speeds, alphaAt, q, zr, top);
    rows.push({
      q, top, range: up.range + down.range, seconds: up.seconds + down.seconds, metres: up.metres + down.metres, nepers: up.nepers + down.nepers,
      departureSine: Math.sqrt(1 - (q * speedOn(speeds, zs)) ** 2), arrivalSine: Math.sqrt(1 - (q * speedOn(speeds, zr)) ** 2), sourceSpeed: speedOn(speeds, zs)
    });
  }
  return rows;
}

function branches(rows) {
  const runs = [];
  let first = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const turns = index + 1 < rows.length && Math.sign(rows[index + 1].range - rows[index].range) !== Math.sign(rows[index].range - rows[index - 1].range);
    if (turns || index + 1 === rows.length) { runs.push([first, index]); first = index; }
  }
  return runs;
}

const RAY_KEYS = Object.freeze(['seconds', 'metres', 'nepers', 'top', 'q', 'departureSine', 'arrivalSine', 'sourceSpeed', 'rangeSlope']);

function rayOn(table, branch, range) {
  const run = table.branches[branch];
  if (!run) return null;
  const { rows } = table;
  const rising = rows[run[1]].range > rows[run[0]].range;
  const below = index => (rows[index].range < range) === rising;
  if (below(run[0]) === below(run[1])) return null;
  let low = run[0];
  let high = run[1];
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (below(middle) === below(low)) low = middle; else high = middle;
  }
  const a = rows[low];
  const b = rows[high];
  const share = (range - a.range) / (b.range - a.range);
  const ray = { rangeSlope: (b.range - a.range) / (b.q - a.q) };
  for (const key of RAY_KEYS) if (key !== 'rangeSlope') ray[key] = a[key] + (b[key] - a[key]) * share;
  return ray;
}

const cache = new Map();

function cached(key, make) {
  let value = cache.get(key);
  if (value === undefined) {
    value = make();
    if (cache.size >= UPPER_AIR.cachedTables) cache.delete(cache.keys().next().value);
  } else {
    cache.delete(key);
  }
  cache.set(key, value);
  return value;
}

function mixRays(rays, weights) {
  if (rays.some(ray => !ray)) return null;
  const mixed = {};
  for (const key of RAY_KEYS) mixed[key] = rays.reduce((sum, ray, index) => sum + ray[key] * weights[index], 0);
  return mixed;
}

export function secondaryBooms(path, flight, receiver, air) {
  const count = path.seconds.length;
  if (!air.refraction || count < 3) return [];
  const reference = UPPER_AIR.absorptionReferenceHz;
  const alphas = Float64Array.from({ length: LEVELS }, (_, level) => (air.absorption ? atmosphericAbsorptionNepersPerMetre(reference, airAtHeight(air, level * UPPER_AIR.stepMetres)) : 0));
  const alphaAt = height => speedOn(alphas, height);
  const receiverHeight = Math.max(0, receiver.z);
  const signature = `${JSON.stringify(air)}|${receiverHeight}`;
  const tables = new Set();
  const make = (azimuthStep, heightStep, rays) => {
    const angle = azimuthStep * UPPER_AIR.azimuthStepDegrees * Math.PI / 180;
    return rayTable(air, Math.sin(angle), Math.cos(angle), heightStep * UPPER_AIR.heightStepMetres, receiverHeight, alphaAt, rays);
  };
  const table = (azimuthStep, heightStep) => {
    const entry = cached(`${signature}|${azimuthStep}:${heightStep}`, () => {
      const rows = make(azimuthStep, heightStep, UPPER_AIR.rays);
      return { rows, branches: branches(rows) };
    });
    tables.add(entry);
    return entry;
  };
  const reach = (azimuthStep, heightStep) => cached(`${signature}|${azimuthStep}:${heightStep}|coarse`, () => (
    (1 - UPPER_AIR.reachMargin) * Math.min(Infinity, ...make(azimuthStep, heightStep, UPPER_AIR.coarseRays).map(row => row.range))
  ));
  const places = Array.from({ length: count }, (_, index) => {
    const dx = receiver.x - path.x[index];
    const dy = receiver.y - path.y[index];
    const range = Math.hypot(dx, dy);
    if (!(range > 0) || path.z[index] < 0 || path.z[index] >= UPPER_AIR.topMetres - UPPER_AIR.heightStepMetres) return null;
    const azimuth = Math.atan2(dx, dy) * 180 / Math.PI / UPPER_AIR.azimuthStepDegrees;
    const height = path.z[index] / UPPER_AIR.heightStepMetres;
    const a = Math.floor(azimuth);
    const z = Math.floor(height);
    const wa = azimuth - a;
    const wz = height - z;
    const corners = [[a, z, (1 - wa) * (1 - wz)], [a + 1, z, wa * (1 - wz)], [a, z + 1, (1 - wa) * wz], [a + 1, z + 1, wa * wz]].filter(corner => corner[2] > 0);
    if (corners.every(([at, up]) => range < reach(at, up))) return null;
    return { range, nx: dx / range, ny: dy / range, tables: corners.map(([at, up]) => table(at, up)), weights: corners.map(corner => corner[2]) };
  });
  const most = Math.max(0, ...[...tables].map(entry => entry.branches.length));
  const booms = [];
  const h = path.step;
  for (let branch = 0; branch < most; branch += 1) {
    const rays = places.map(place => place && mixRays(place.tables.map(entry => rayOn(entry, branch, place.range)), place.weights));
    const slope = rays.map((ray, index) => {
      if (!ray) return NaN;
      const { nx, ny } = places[index];
      const closing = path.vx[index] * nx + path.vy[index] * ny;
      return 1 - ray.q * closing - path.vz[index] * ray.departureSine / ray.sourceSpeed;
    });
    for (let index = 0; index + 1 < count; index += 1) {
      if (!(slope[index] < 0 && slope[index + 1] >= 0)) continue;
      const share = -slope[index] / (slope[index + 1] - slope[index]);
      const curvature = (slope[index + 1] - slope[index]) / h;
      const blend = values => values[index] + (values[index + 1] - values[index]) * share;
      const ray = {};
      for (const key of RAY_KEYS) ray[key] = rays[index][key] + (rays[index + 1][key] - rays[index][key]) * share;
      ray.nx = places[index].nx + (places[index + 1].nx - places[index].nx) * share;
      ray.ny = places[index].ny + (places[index + 1].ny - places[index].ny) * share;
      booms.push(secondaryBoom(path, flight, receiver, air, ray, blend, curvature, alphaAt));
    }
  }
  return booms.filter(Boolean);
}

function secondaryBoom(path, flight, receiver, air, ray, blend, curvature, alphaAt) {
  const point = { x: blend(path.x), y: blend(path.y), z: blend(path.z) };
  const speed = blend(path.speed);
  const soundSpeed = Math.sqrt(C_FACTOR * upperTemperatureKelvin(air, point.z));
  const mach = speed / soundSpeed;
  if (!(mach > 1)) return null;
  const boom = carlsonBoom({
    mach, vehiclePressurePa: pressureAtHeightPa(air, point.z), groundPressurePa: pressureAtHeightPa(air, Math.max(0, receiver.z)),
    vehicleSoundSpeed: soundSpeed, lengthMetres: flight.lengthMetres, shapeFactor: flight.shapeFactor, distanceMetres: ray.metres
  });
  const width = Math.abs(ray.rangeSlope) * ray.departureSine / ray.sourceSpeed * ray.arrivalSine;
  const spreading = Math.min(FLIGHT.focusLimit, Math.sqrt(ray.metres / Math.max(width, ray.metres / FLIGHT.focusLimit ** 2)));
  const meanSpeed = ray.metres / ray.seconds;
  const steady = speed * speed * (1 - 1 / (mach * mach)) / (meanSpeed * ray.metres);
  const focus = Math.min(FLIGHT.focusLimit, Math.sqrt(steady / Math.max(curvature, steady / FLIGHT.focusLimit ** 2)));
  const departureCos = Math.sqrt(1 - ray.departureSine ** 2);
  const arrivalCos = Math.sqrt(1 - ray.arrivalSine ** 2);
  const low = Math.max(0, receiver.z);
  let integral = 0;
  const pieces = Math.max(1, Math.ceil((ray.top - low) / UPPER_AIR.stepMetres));
  for (let piece = 0; piece < pieces; piece += 1) integral += alphaAt(low + (piece + .5) * (ray.top - low) / pieces) * (ray.top - low) / pieces;
  const mean = integral / Math.max(1, ray.top - low);
  return {
    point, emissionSeconds: blend(path.seconds), mach, focus, shadow: false, secondary: true,
    ray: {
      seconds: ray.seconds, metres: ray.metres, spreadMetres: ray.metres,
      departure: { x: ray.nx * departureCos, y: ray.ny * departureCos, z: ray.departureSine },
      arrival: { x: ray.nx * arrivalCos, y: ray.ny * arrivalCos, z: -ray.arrivalSine }
    },
    topMetres: ray.top,
    absorptionExcess: mean > 0 ? ray.nepers / (mean * ray.metres) - 1 : 0,
    overpressurePa: boom.overpressurePa * spreading,
    durationSeconds: boom.durationSeconds
  };
}
