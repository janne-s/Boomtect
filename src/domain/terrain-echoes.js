import { inShadow, PATH_ECHO, PATH_SCATTER, pathProfile, rayBetween, rayTiming } from './refraction.js';
import { meanPlaneFrame } from './terrain-propagation.js';

/**
 * First-order echoes from terrain, after Echotect `src/terrain-space.js` at commit cb712ef: the
 * scattering share `s` splits each surface's reflected energy, `1 − s` specularly at the stationary
 * points of the path length on the surface (Fermat), `s` from every facet as a Lambertian patch.
 * Adapted to Boomtect's frame and units, to a coarser echo grid of its own, and to source cells:
 * point sources are pooled into cells of `cellMetres` and `CELL_SECONDS`, and each cell's echoes at a
 * receiver are traced once (architecture decision 2, option B).
 *
 * Classes: the specular geometry is A on the given surface; the Lambertian energy
 * A·cosθᵢ·cosθₒ/π·((r₁+r₂)/(r₁r₂))² relative to an image source over the same path is B (Kuttruff,
 * Room Acoustics, diffuse reflection); the cells, the scattering share, the echo grid, the
 * visibility test, and the echo limit are C.
 */

/** The echo grid's longest side; finer terrain is sampled down to it. */
const ECHO_GRID_SIDE = 150;
/** Directions and growing steps of each facet's horizon, which settles most visibility questions at once. */
const HORIZON_AZIMUTHS = 16;
const HORIZON_STEP_GROWTH = .15;
/** Sources whose emissions lie this far apart fall in different cells, so strokes stay apart. */
export const CELL_SECONDS = .02;
/** Scattered patches merge by arrival in bins of this width and by direction in these sectors. */
export const SCATTER_BIN_SECONDS = .01;
const AZIMUTH_SECTORS = 8;
const ELEVATION_SECTORS = 3;
/** Ground within this many echo cells of a receiver, or of a source near the ground, is the ground reflection's. */
const EXCLUSION_SPACINGS = 1.5;
/** Newton search for specular points: finite-difference step, convergence, and iterations, in echo cells. */
const NEWTON_STEP_SPACINGS = .25;
const NEWTON_TOLERANCE_SPACINGS = 1e-3;
const NEWTON_ITERATIONS = 12;
/**
 * A specular point on the plane under the receiver, within this angle and this height, is the ground
 * reflection, which the receiver's paths already carry; the height tolerance grows with the echo cell.
 */
const COPLANAR_COSINE = Math.cos(2 * Math.PI / 180);
const COPLANAR_METRES = .5;
const COPLANAR_SPACINGS = .035;
/** Energy gain of a focusing concave reflection at most, where the caustic would diverge: 10 dB. */
const MAXIMUM_FOCUSING = 10;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

/**
 * Pools an emitter's point sources into cells of `cellMetres` in space and CELL_SECONDS in emission
 * time. A cell is one point source at the energy-weighted centre, emission time, and pulse of its
 * sources; its amplitude adds their energies, because their arrivals spread over more than a pulse
 * at any echo. Returns a table shaped like `sourceTable`, without directivity (class C), with each
 * cell's `place`: the cells of one place in space differ only in time, such as a channel's strokes,
 * and share the echo geometry traced from the place's centre in `places`.
 */
export function sourceCells(sources, cellMetres) {
  const placeIndex = new Map();
  const index = new Map();
  const members = [];
  const placeOf = [];
  const placeMembers = [];
  for (let source = 0; source < sources.length; source += 1) {
    const where = `${Math.floor(sources.x[source] / cellMetres)},${Math.floor(sources.y[source] / cellMetres)},${Math.floor(sources.z[source] / cellMetres)}`;
    let place = placeIndex.get(where);
    if (place === undefined) { place = placeMembers.length; placeIndex.set(where, place); placeMembers.push([]); }
    placeMembers[place].push(source);
    const key = `${where},${Math.floor(sources.emissionSeconds[source] / CELL_SECONDS)}`;
    let cell = index.get(key);
    if (cell === undefined) { cell = members.length; index.set(key, cell); members.push([]); placeOf.push(place); }
    members[cell].push(source);
  }
  const places = { length: placeMembers.length, x: new Float64Array(placeMembers.length), y: new Float64Array(placeMembers.length), z: new Float64Array(placeMembers.length) };
  placeMembers.forEach((list, place) => {
    let energy = 0;
    for (const source of list) energy += sources.amplitudePaMetres[source] ** 2;
    for (const source of list) {
      const weight = energy > 0 ? sources.amplitudePaMetres[source] ** 2 / energy : 1 / list.length;
      places.x[place] += weight * sources.x[source];
      places.y[place] += weight * sources.y[source];
      places.z[place] += weight * sources.z[source];
    }
  });
  const length = members.length;
  const table = {
    length,
    place: Uint32Array.from(placeOf),
    places,
    x: new Float64Array(length), y: new Float64Array(length), z: new Float64Array(length),
    dx: new Float64Array(length), dy: new Float64Array(length), dz: new Float64Array(length),
    directed: new Uint8Array(length),
    elementMetres: new Float64Array(length),
    emissionSeconds: new Float64Array(length),
    amplitudePaMetres: new Float64Array(length),
    friedlander: new Uint8Array(length),
    durationSeconds: new Float64Array(length),
    decay: new Float64Array(length),
    spanSeconds: new Float64Array(length),
    linearRadiusMetres: new Float64Array(length),
    relaxationRadius: new Float64Array(length),
    sourcePeriodSeconds: new Float64Array(length),
    limitRadii: new Float64Array(length)
  };
  const averaged = ['x', 'y', 'z', 'emissionSeconds', 'durationSeconds', 'decay', 'relaxationRadius', 'sourcePeriodSeconds', 'limitRadii'];
  members.forEach((list, cell) => {
    let energy = 0;
    for (const source of list) energy += sources.amplitudePaMetres[source] ** 2;
    const weight = source => (energy > 0 ? sources.amplitudePaMetres[source] ** 2 / energy : 1 / list.length);
    for (const key of averaged) {
      let sum = 0;
      for (const source of list) sum += weight(source) * sources[key][source];
      table[key][cell] = sum;
    }
    table.amplitudePaMetres[cell] = Math.sqrt(energy);
    table.friedlander[cell] = sources.friedlander[list[0]];
    for (const source of list) {
      table.spanSeconds[cell] = Math.max(table.spanSeconds[cell], sources.spanSeconds[source]);
      table.linearRadiusMetres[cell] = Math.max(table.linearRadiusMetres[cell], sources.linearRadiusMetres[source]);
    }
  });
  return table;
}

const surfaces = new WeakMap();

/**
 * The echo grid of a terrain surface: facet centres, heights, slopes, areas, and each facet's
 * horizon, the steepest rise of the ground seen from it in HORIZON_AZIMUTHS directions. Cached
 * per surface.
 */
export function echoSurface(surface) {
  const cached = surfaces.get(surface);
  if (cached) return cached;
  const half = surface.halfExtentMetres;
  const side = Math.max(2, Math.min(ECHO_GRID_SIDE, Math.round(2 * half / surface.cellMetres)));
  const spacing = 2 * half / side;
  const count = side * side;
  const centre = index => -half + (index + .5) * spacing;
  const heights = new Float64Array(count);
  for (let row = 0; row < side; row += 1) for (let column = 0; column < side; column += 1) heights[row * side + column] = surface.heightAt(centre(column), centre(row));
  const gradientX = new Float64Array(count);
  const gradientY = new Float64Array(count);
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const west = Math.max(0, column - 1); const east = Math.min(side - 1, column + 1);
      const south = Math.max(0, row - 1); const north = Math.min(side - 1, row + 1);
      gradientX[row * side + column] = (heights[row * side + east] - heights[row * side + west]) / ((east - west) * spacing);
      gradientY[row * side + column] = (heights[north * side + column] - heights[south * side + column]) / ((north - south) * spacing);
    }
  }
  const bilinear = (values, x, y) => {
    const gridX = clamp((x + half) / spacing - .5, 0, side - 1);
    const gridY = clamp((y + half) / spacing - .5, 0, side - 1);
    const x0 = Math.min(side - 2, Math.floor(gridX));
    const y0 = Math.min(side - 2, Math.floor(gridY));
    const fx = gridX - x0;
    const fy = gridY - y0;
    const at = y0 * side + x0;
    return (values[at] * (1 - fx) + values[at + 1] * fx) * (1 - fy) + (values[at + side] * (1 - fx) + values[at + side + 1] * fx) * fy;
  };
  const heightAt = (x, y) => bilinear(heights, x, y);
  const horizon = new Float32Array(count * HORIZON_AZIMUTHS);
  for (let facet = 0; facet < count; facet += 1) {
    const x = centre(facet % side);
    const y = centre(Math.floor(facet / side));
    for (let azimuth = 0; azimuth < HORIZON_AZIMUTHS; azimuth += 1) {
      const angle = 2 * Math.PI * azimuth / HORIZON_AZIMUTHS;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      let steepest = -Infinity;
      for (let along = spacing; ; along += Math.max(spacing, along * HORIZON_STEP_GROWTH)) {
        const px = x + ux * along;
        const py = y + uy * along;
        if (Math.abs(px) > half || Math.abs(py) > half) break;
        steepest = Math.max(steepest, (heightAt(px, py) - heights[facet]) / along);
      }
      horizon[facet * HORIZON_AZIMUTHS + azimuth] = steepest;
    }
  }
  let lowest = Infinity;
  let highest = -Infinity;
  for (const height of heights) { lowest = Math.min(lowest, height); highest = Math.max(highest, height); }
  const echo = {
    side, spacing, half, count, heights, lowest, highest, gradientX, gradientY, horizon, heightAt,
    centreX: facet => centre(facet % side),
    centreY: facet => centre(Math.floor(facet / side)),
    slopeAt: (x, y) => ({ x: bilinear(gradientX, x, y), y: bilinear(gradientY, x, y) })
  };
  surfaces.set(surface, echo);
  return echo;
}

/**
 * Whether the straight line between two points clears the echo grid's ground, sampled once per echo
 * cell. Ground within one echo cell of either end is not checked: a facet stands on it, and finer
 * ground is unknown (class C; refraction does not bend this line).
 */
export function clearBetween(echo, a, b) {
  const horizontal = Math.hypot(b.x - a.x, b.y - a.y);
  const { spacing } = echo;
  const count = Math.floor((horizontal - 2 * spacing) / spacing);
  for (let index = 0; index <= count; index += 1) {
    const along = spacing + index * spacing;
    const share = along / horizontal;
    if (a.z + (b.z - a.z) * share < echo.heightAt(a.x + (b.x - a.x) * share, a.y + (b.y - a.y) * share)) return false;
  }
  return true;
}

/** Whether a point is visible from a facet: above its horizon in that direction, or else along a clear line. */
function visibleFromFacet(echo, facet, facetPoint, point) {
  const dx = point.x - facetPoint.x;
  const dy = point.y - facetPoint.y;
  const horizontal = Math.hypot(dx, dy);
  if (!(horizontal > echo.spacing)) return point.z >= facetPoint.z;
  const rise = (point.z - facetPoint.z) / horizontal;
  const position = ((Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1) * HORIZON_AZIMUTHS;
  const lower = Math.floor(position) % HORIZON_AZIMUTHS;
  const upper = (lower + 1) % HORIZON_AZIMUTHS;
  const base = facet * HORIZON_AZIMUTHS;
  if (rise > Math.max(echo.horizon[base + lower], echo.horizon[base + upper])) return true;
  return clearBetween(echo, facetPoint, point);
}

/**
 * Everything about one receiver's echoes that does not depend on the source: the facets it sees,
 * outside the ground under it, with their distance, exit cosine, and direction sector.
 */
export function echoField(surface, profile, receiverPosition, { scattering, limit }) {
  const echo = echoSurface(surface);
  const R = receiverPosition;
  const exclusion = EXCLUSION_SPACINGS * echo.spacing;
  const visible = [];
  const distance = new Float64Array(echo.count);
  const exitCosine = new Float64Array(echo.count);
  const sector = new Uint16Array(echo.count);
  for (let facet = 0; facet < echo.count; facet += 1) {
    const point = { x: echo.centreX(facet), y: echo.centreY(facet), z: echo.heights[facet] };
    const dx = R.x - point.x;
    const dy = R.y - point.y;
    const dz = R.z - point.z;
    const horizontal = Math.hypot(dx, dy);
    if (horizontal < exclusion) continue;
    const r2 = Math.hypot(horizontal, dz);
    const gx = echo.gradientX[facet];
    const gy = echo.gradientY[facet];
    const cosine = (-gx * dx - gy * dy + dz) / (Math.hypot(gx, gy, 1) * r2);
    if (!(cosine > 0)) continue;
    if (!visibleFromFacet(echo, facet, point, R)) continue;
    visible.push(facet);
    distance[facet] = r2;
    exitCosine[facet] = cosine;
    sector[facet] = arrivalSector({ x: dx / r2, y: dy / r2, z: dz / r2 });
  }
  const ground = { x: R.x, y: R.y, z: surface.heightAt(R.x, R.y) };
  const groundPlane = { point: ground, normal: surface.normalAt(R.x, R.y) };
  const seen = new Uint8Array(echo.count);
  for (const facet of visible) seen[facet] = 1;
  return { echo, profile, surface, R, groundPlane, scattering, limit, visible: Int32Array.from(visible), seen, distance, exitCosine, sector };
}

/** The horizontal gradient of the S → point → R path length for a point that follows the surface. */
function pathGradient(S, R, x, y, z, slope) {
  const sx = x - S.x; const sy = y - S.y; const sz = z - S.z;
  const rx = x - R.x; const ry = y - R.y; const rz = z - R.z;
  const ls = Math.hypot(sx, sy, sz);
  const lr = Math.hypot(rx, ry, rz);
  const sumZ = sz / ls + rz / lr;
  return [sx / ls + rx / lr + slope.x * sumZ, sy / ls + ry / lr + slope.y * sumZ];
}

function jacobian(gradient, x, y, step) {
  const east = gradient(x + step, y); const west = gradient(x - step, y);
  const north = gradient(x, y + step); const south = gradient(x, y - step);
  return [
    [(east[0] - west[0]) / (2 * step), (north[0] - south[0]) / (2 * step)],
    [(east[1] - west[1]) / (2 * step), (north[1] - south[1]) / (2 * step)]
  ];
}

const determinant = matrix => matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];

/**
 * Specular points between S and R on the echo surface: where the path gradient along the surface
 * vanishes, found by Newton from every grid square whose corners bracket zero. Each point's energy
 * relative to an image source follows stationary phase, the ratio of the path Hessians on the
 * tangent plane and on the curved surface, so a convex slope weakens its echo and a concave one
 * focuses it, up to MAXIMUM_FOCUSING.
 */
export function specularPoints(echo, S, R, field = null) {
  const { side, spacing } = echo;
  const step = spacing * NEWTON_STEP_SPACINGS;
  const surfaceGradient = (x, y) => pathGradient(S, R, x, y, echo.heightAt(x, y), echo.slopeAt(x, y));
  // With a receiver's field, only the ground it sees can echo, so only that ground is searched.
  const facets = field ? field.visible : Int32Array.from({ length: echo.count }, (_, facet) => facet);
  const seen = field?.seen;
  const gradients = field ? (field.gradients ??= new Float64Array(2 * echo.count)) : new Float64Array(2 * echo.count);
  for (const facet of facets) {
    const x = echo.centreX(facet); const y = echo.centreY(facet); const z = echo.heights[facet];
    const sx = x - S.x; const sy = y - S.y; const sz = z - S.z;
    const rx = x - R.x; const ry = y - R.y; const rz = z - R.z;
    const ls = Math.hypot(sx, sy, sz);
    const lr = Math.hypot(rx, ry, rz);
    const sumZ = sz / ls + rz / lr;
    gradients[2 * facet] = sx / ls + rx / lr + echo.gradientX[facet] * sumZ;
    gradients[2 * facet + 1] = sy / ls + ry / lr + echo.gradientY[facet] * sumZ;
  }
  const found = new Map();
  for (const first of facets) {
    if (first % side === side - 1 || first >= side * (side - 1)) continue;
    {
      const corners = [first, first + 1, first + side, first + side + 1];
      // A specular point the receiver cannot see does not echo; neither does one beside such ground.
      if (seen && !(seen[corners[1]] && seen[corners[2]] && seen[corners[3]])) continue;
      let xNegative = false; let xPositive = false; let yNegative = false; let yPositive = false;
      for (const corner of corners) {
        const gx = gradients[2 * corner]; const gy = gradients[2 * corner + 1];
        xNegative ||= gx <= 0; xPositive ||= gx >= 0; yNegative ||= gy <= 0; yPositive ||= gy >= 0;
      }
      if (!(xNegative && xPositive && yNegative && yPositive)) continue;
      let x = echo.centreX(corners[0]) + spacing / 2;
      let y = echo.centreY(corners[0]) + spacing / 2;
      let converged = false;
      for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
        const residual = surfaceGradient(x, y);
        const matrix = jacobian(surfaceGradient, x, y, step);
        const det = determinant(matrix);
        if (!(Math.abs(det) > 0)) break;
        let dx = (matrix[1][1] * residual[0] - matrix[0][1] * residual[1]) / det;
        let dy = (matrix[0][0] * residual[1] - matrix[1][0] * residual[0]) / det;
        const size = Math.hypot(dx, dy);
        if (size > spacing) { dx *= spacing / size; dy *= spacing / size; }
        x -= dx; y -= dy;
        if (Math.hypot(dx, dy) < spacing * NEWTON_TOLERANCE_SPACINGS) { converged = true; break; }
      }
      if (!converged || Math.abs(x) > echo.half || Math.abs(y) > echo.half) continue;
      const key = `${Math.round(x / spacing * 100)},${Math.round(y / spacing * 100)}`;
      if (found.has(key)) continue;
      const z = echo.heightAt(x, y);
      const slope = echo.slopeAt(x, y);
      const plane = jacobian((px, py) => pathGradient(S, R, px, py, z + slope.x * (px - x) + slope.y * (py - y), slope), x, y, step);
      const curved = jacobian(surfaceGradient, x, y, step);
      const focusing = Math.min(MAXIMUM_FOCUSING, Math.abs(determinant(plane)) / Math.max(Number.MIN_VALUE, Math.abs(determinant(curved))));
      const length = Math.hypot(slope.x, slope.y, 1);
      found.set(key, { point: { x, y, z }, normal: { x: -slope.x / length, y: -slope.y / length, z: 1 / length }, focusing });
    }
  }
  return [...found.values()];
}

/** Whether a surface point and its normal lie on the tangent plane under the receiver. */
function onGroundPlane(field, point, normal) {
  const { point: ground, normal: up } = field.groundPlane;
  if (normal.x * up.x + normal.y * up.y + normal.z * up.z < COPLANAR_COSINE) return false;
  const offset = (point.x - ground.x) * up.x + (point.y - ground.y) * up.y + (point.z - ground.z) * up.z;
  return Math.abs(offset) < COPLANAR_METRES + COPLANAR_SPACINGS * field.echo.spacing;
}

/** Ground samples for the mean plane of an echo leg, fewer than for the direct sound (class C). */
const LEG_PLANE_SAMPLES = 8;

/**
 * One leg of an echo, timed along the refracted ray. Null when it would pass through the refraction
 * shadow, judged from the mean ground plane under it as for the direct sound.
 */
function echoLeg(field, a, b, trace = rayBetween) {
  const { echo } = field;
  const profile = pathProfile(field.profile, a, b);
  if (profile.gradient < 0) {
    const frame = meanPlaneFrame(profile, echo.heightAt, a, b, LEG_PLANE_SAMPLES);
    if (inShadow(frame.profile, frame.from, frame.to)) return null;
  }
  return trace(profile, a, b);
}

/**
 * An upper bound on the path from S over any facet to R, which bounds the clusters' arrival bins:
 * the sum of horizontal distances is largest at a corner of the square, and the vertical legs at
 * the lowest or highest ground.
 */
function maximumPathMetres(echo, S, R) {
  let horizontal = 0;
  for (const x of [-echo.half, echo.half]) for (const y of [-echo.half, echo.half]) horizontal = Math.max(horizontal, Math.hypot(S.x - x, S.y - y) + Math.hypot(R.x - x, R.y - y));
  const vertical = point => Math.max(Math.abs(point.z - echo.lowest), Math.abs(point.z - echo.highest));
  return horizontal + vertical(S) + vertical(R);
}

/** Zeroed cluster accumulators kept with the field and grown as needed; echoPaths leaves them zeroed. */
function clusterBuffers(field, size) {
  if (!field.clusters || field.clusters.energy.length < size) {
    const length = Math.max(size, 2 * (field.clusters?.energy.length ?? 0));
    field.clusters = { energy: new Float64Array(length), x: new Float64Array(length), y: new Float64Array(length), cosine: new Float64Array(length) };
  }
  return field.clusters;
}

/**
 * The echo paths from a source point, a place of source cells, at the field's receiver: specular
 * echoes (PATH_ECHO) and merged Lambertian patches (PATH_SCATTER), the strongest `limit` of them.
 * Each path has the shape of a ray from `refraction.js` plus `groundSine`, the cosine of incidence
 * on the reflecting surface, and `kind`. Spreading follows the image source over the two legs,
 * scaled by the echo's energy.
 */
export function echoPaths(field, S) {
  const { echo, R, scattering, limit } = field;
  const exclusion = EXCLUSION_SPACINGS * echo.spacing;
  const nearGround = S.z - echo.heightAt(S.x, S.y) < echo.spacing;
  const candidates = [];

  if (scattering < 1) {
    for (const { point, normal, focusing } of specularPoints(echo, S, R, field)) {
      if (Math.hypot(point.x - R.x, point.y - R.y) < exclusion || onGroundPlane(field, point, normal)) continue;
      if (nearGround && Math.hypot(point.x - S.x, point.y - S.y) < exclusion) continue;
      const r1 = Math.hypot(S.x - point.x, S.y - point.y, S.z - point.z);
      const r2 = Math.hypot(R.x - point.x, R.y - point.y, R.z - point.z);
      const cosine = (normal.x * (S.x - point.x) + normal.y * (S.y - point.y) + normal.z * (S.z - point.z)) / r1;
      const exit = (normal.x * (R.x - point.x) + normal.y * (R.y - point.y) + normal.z * (R.z - point.z)) / r2;
      if (!(cosine > 0 && exit > 0)) continue;
      if (!clearBetween(echo, point, S) || !clearBetween(echo, point, R)) continue;
      candidates.push({ kind: PATH_ECHO, energy: (1 - scattering) * focusing, point, cosine, r1, r2 });
    }
  }

  if (scattering > 0) {
    const sectors = AZIMUTH_SECTORS * ELEVATION_SECTORS;
    const area = echo.spacing * echo.spacing;
    const binsPerMetre = 1 / (field.profile.groundSpeed * SCATTER_BIN_SECONDS);
    const clusters = clusterBuffers(field, sectors * (Math.floor(maximumPathMetres(echo, S, R) * binsPerMetre) + 1));
    const touched = [];
    for (const facet of field.visible) {
      const x = echo.centreX(facet); const y = echo.centreY(facet); const z = echo.heights[facet];
      const dx = S.x - x; const dy = S.y - y; const dz = S.z - z;
      const r1 = Math.hypot(dx, dy, dz);
      const gx = echo.gradientX[facet]; const gy = echo.gradientY[facet];
      const slopeFactor = Math.hypot(gx, gy, 1);
      const cosine = (-gx * dx - gy * dy + dz) / (slopeFactor * r1);
      if (!(cosine > 0)) continue;
      if (nearGround && Math.hypot(dx, dy) < exclusion) continue;
      if (!visibleFromFacet(echo, facet, { x, y, z }, S)) continue;
      const r2 = field.distance[facet];
      const energy = scattering * area * slopeFactor * cosine * field.exitCosine[facet] / Math.PI * ((r1 + r2) / (r1 * r2)) ** 2;
      const key = Math.floor((r1 + r2) * binsPerMetre) * sectors + field.sector[facet];
      if (clusters.energy[key] === 0) touched.push(key);
      clusters.energy[key] += energy;
      clusters.x[key] += energy * x;
      clusters.y[key] += energy * y;
      clusters.cosine[key] += energy * cosine;
    }
    for (const key of touched) {
      const energy = clusters.energy[key];
      const x = clusters.x[key] / energy;
      const y = clusters.y[key] / energy;
      const cosine = clusters.cosine[key] / energy;
      clusters.energy[key] = 0; clusters.x[key] = 0; clusters.y[key] = 0; clusters.cosine[key] = 0;
      if (!(energy > 0)) continue;
      const point = { x, y, z: echo.heightAt(x, y) };
      const r1 = Math.hypot(S.x - x, S.y - y, S.z - point.z);
      const r2 = Math.hypot(R.x - x, R.y - y, R.z - point.z);
      candidates.push({ kind: PATH_SCATTER, energy, point, cosine, r1, r2 });
    }
  }

  candidates.sort((a, b) => b.energy / (a.r1 + a.r2) ** 2 - a.energy / (b.r1 + b.r2) ** 2 || a.kind - b.kind);
  const paths = [];
  for (const candidate of candidates) {
    if (paths.length >= limit) break;
    const { r1, r2, point } = candidate;
    if (candidate.kind === PATH_SCATTER) {
      // Scattered energy arrives from a patch, so its direction and length are the straight ones (class C).
      const down = echoLeg(field, S, point, rayTiming);
      const up = down && echoLeg(field, point, R, rayTiming);
      if (!up) continue;
      const arrival = { x: (R.x - point.x) / r2, y: (R.y - point.y) / r2, z: (R.z - point.z) / r2 };
      paths.push({
        kind: PATH_SCATTER,
        seconds: down.seconds + up.seconds,
        metres: r1 + r2,
        spreadMetres: (r1 + r2) / Math.sqrt(candidate.energy) * down.spreadMetres * up.spreadMetres / (r1 * r2),
        departure: { x: (point.x - S.x) / r1, y: (point.y - S.y) / r1, z: (point.z - S.z) / r1 },
        arrival,
        groundSine: candidate.cosine
      });
      continue;
    }
    const down = echoLeg(field, S, point);
    const up = down && echoLeg(field, point, R);
    if (!up) continue;
    // Spreading of the image source in homogeneous air, r₁ + r₂, carried over to refracted legs.
    const spreadMetres = (down.spreadMetres + up.spreadMetres) / Math.sqrt(candidate.energy);
    paths.push({
      kind: PATH_ECHO,
      seconds: down.seconds + up.seconds,
      metres: down.metres + up.metres,
      spreadMetres,
      departure: down.departure,
      arrival: up.arrival,
      groundSine: candidate.cosine
    });
  }
  return paths;
}

/** The direction sector of a propagation direction arriving at a receiver, as the clusters use. */
export function arrivalSector(arrival) {
  const azimuth = Math.floor(((Math.atan2(-arrival.y, -arrival.x) / (2 * Math.PI) + 1) % 1) * AZIMUTH_SECTORS) % AZIMUTH_SECTORS;
  const elevation = Math.min(ELEVATION_SECTORS - 1, Math.floor((Math.asin(clamp(-arrival.z, -1, 1)) / Math.PI + .5) * ELEVATION_SECTORS));
  return azimuth * ELEVATION_SECTORS + elevation;
}
