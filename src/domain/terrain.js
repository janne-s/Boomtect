import { GROUND, VIEW } from './constants.js';

/**
 * Terrain from Terrarium elevation tiles as a heightfield in the scene frame: x east and y north
 * in metres from the scene origin, row 0 in the south. Heights are metres above sea level, lowered
 * onto the tangent plane at the origin for the Earth's curvature.
 *
 * Adopted from Echotect `src/terrain-tiles.js` and `src/terrain-space.js` at commit cb712ef
 * (tile arithmetic, Terrarium decoding, the capture plan, the heightfield resampling, and the
 * base64 encoding), with Boomtect's units and square patches on a grid anchored at the origin.
 */

export const TERRAIN_PROVIDER = Object.freeze({
  id: 'aws-terrain-tiles-terrarium',
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  attribution: 'Terrain Tiles: Mapzen / AWS Open Data (SRTM, GMTED2010, NED, ETOPO1, EU-DEM and national datasets)',
  attributionUrl: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md'
});

export const EARTH_RADIUS_METRES = 6371008.8;
const EARTH_CIRCUMFERENCE_METRES = 40075016.686;
export const TILE_SIZE = 256;
const MAXIMUM_TILE_ZOOM = 15;
const MINIMUM_TILE_ZOOM = 1;
const MAXIMUM_MERCATOR_LATITUDE = 85.05112878;
const METRES_PER_DEGREE = EARTH_RADIUS_METRES * Math.PI / 180;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export const metresPerDegree = latitude => ({ north: METRES_PER_DEGREE, east: METRES_PER_DEGREE * Math.cos(latitude * Math.PI / 180) });

/** Terrarium encodes elevation as red·256 + green + blue/256 − 32768 metres. */
export const decodeTerrarium = (red, green, blue) => red * 256 + green + blue / 256 - 32768;

/** Drop of a level surface below the tangent plane at the origin, in metres. */
export const curvatureDropMetres = horizontalMetres => horizontalMetres ** 2 / (2 * EARTH_RADIUS_METRES);

export const tileX = (longitude, zoom) => (longitude + 180) / 360 * 2 ** zoom;

export function tileY(latitude, zoom) {
  const radians = clamp(latitude, -MAXIMUM_MERCATOR_LATITUDE, MAXIMUM_MERCATOR_LATITUDE) * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * 2 ** zoom;
}

export const tilePixelMetres = (latitude, zoom) => EARTH_CIRCUMFERENCE_METRES * Math.cos(latitude * Math.PI / 180) / (TILE_SIZE * 2 ** zoom);

function tileRange(bounds, zoom) {
  const last = 2 ** zoom - 1;
  const west = clamp(Math.floor(tileX(bounds.west, zoom)), 0, last);
  const east = clamp(Math.floor(tileX(bounds.east, zoom)), 0, last);
  const north = clamp(Math.floor(tileY(bounds.north, zoom)), 0, last);
  const south = clamp(Math.floor(tileY(bounds.south, zoom)), 0, last);
  return { west, east, north, south, count: (east - west + 1) * (south - north + 1) };
}

/** Latitude of a tile row's edge at a zoom, the inverse of `tileY`. */
const tileLatitude = (y, zoom) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom))) * 180 / Math.PI;

/**
 * The map tiles covering a rectangle of the scene frame (`bounds`: west, east, south, north in metres
 * from the origin at `latitude`, `longitude`), each with its north-west, north-east, and south-west
 * corners in the scene frame. The zoom is the finest at which about VIEW.map.pixelsAcross pixels span
 * the rectangle's longer side, within GROUND.terrain.maximumTileRequests tiles.
 */
export function mapTiles({ latitude, longitude, bounds }) {
  const { north, east } = metresPerDegree(latitude);
  const degrees = { west: longitude + bounds.west / east, east: longitude + bounds.east / east, south: latitude + bounds.south / north, north: latitude + bounds.north / north };
  const side = Math.max(bounds.east - bounds.west, bounds.north - bounds.south);
  let zoom = VIEW.map.maximumZoom;
  while (zoom > MINIMUM_TILE_ZOOM && (tilePixelMetres(latitude, zoom) < side / VIEW.map.pixelsAcross || tileRange(degrees, zoom).count > GROUND.terrain.maximumTileRequests)) zoom -= 1;
  const range = tileRange(degrees, zoom);
  const local = (x, y) => ({ x: ((x / 2 ** zoom) * 360 - 180 - longitude) * east, y: (tileLatitude(y, zoom) - latitude) * north });
  const tiles = [];
  for (let y = range.north; y <= range.south; y += 1) {
    for (let x = range.west; x <= range.east; x += 1) tiles.push({ x, y, zoom, northWest: local(x, y), northEast: local(x + 1, y), southWest: local(x, y + 1) });
  }
  return { zoom, tiles };
}

/**
 * Terrain comes in square patches of GROUND.terrain.patchCells cells on a grid anchored at the scene
 * origin: patch (column, row) covers x from column·side to (column + 1)·side, and y likewise. A scene
 * holds a rectangle of whole patches, so that the ground it needs is loaded and no more.
 */
export const patchMetres = cellMetres => GROUND.terrain.patchCells * cellMetres;

/** The patches that cover a rectangle of the scene frame, as inclusive column and row ranges. */
export function patchRange({ west, east, south, north }, cellMetres) {
  const side = patchMetres(cellMetres);
  const first = value => Math.floor(value / side);
  // A rectangle that ends on a patch's edge does not reach into the next one.
  const last = value => Math.ceil(value / side) - 1;
  return { column0: first(west), column1: Math.max(first(west), last(east)), row0: first(south), row1: Math.max(first(south), last(north)) };
}

/** The patches of a range, in rows from the south. */
export function rangePatches(range) {
  const list = [];
  for (let row = range.row0; row <= range.row1; row += 1) for (let column = range.column0; column <= range.column1; column += 1) list.push({ column, row });
  return list;
}

export const patchCount = range => (range.column1 - range.column0 + 1) * (range.row1 - range.row0 + 1);

/** The rectangle of the scene frame that a range of patches covers. */
export function rangeBounds(range, cellMetres) {
  const side = patchMetres(cellMetres);
  return { west: range.column0 * side, east: (range.column1 + 1) * side, south: range.row0 * side, north: (range.row1 + 1) * side };
}

/**
 * The tiles and zoom for fetching a rectangle: the coarsest whose pixels are no larger than the
 * cell, within GROUND.terrain.maximumTileRequests.
 */
export function tilePlan({ latitude, longitude }, bounds, cellMetres) {
  const { north, east } = metresPerDegree(latitude);
  const degrees = { west: longitude + bounds.west / east, east: longitude + bounds.east / east, south: latitude + bounds.south / north, north: latitude + bounds.north / north };
  let zoom = MAXIMUM_TILE_ZOOM;
  while (zoom > MINIMUM_TILE_ZOOM && tilePixelMetres(latitude, zoom - 1) <= cellMetres) zoom -= 1;
  while (zoom > MINIMUM_TILE_ZOOM && tileRange(degrees, zoom).count > GROUND.terrain.maximumTileRequests) zoom -= 1;
  return { zoom, tiles: tileRange(degrees, zoom) };
}

/**
 * Where a point of the scene frame lies on the tile mosaic at a zoom, in global pixels whose centres
 * are at whole numbers.
 */
export function tilePixel({ latitude, longitude }, x, y, zoom) {
  const { north, east } = metresPerDegree(latitude);
  return { x: tileX(longitude + x / east, zoom) * TILE_SIZE - .5, y: tileY(latitude + y / north, zoom) * TILE_SIZE - .5 };
}

/**
 * A patch: `heightAt(x, y)` in metres above sea level at its cell centres, row 0 in the south,
 * stored as 16-bit steps above its lowest cell, each step its height range over 65 535 (at least
 * GROUND.terrain.minimumHeightStepMetres): millimetres on gentle ground, decimetres in high mountains.
 */
export function buildPatch(column, row, cellMetres, heightAt) {
  const cells = GROUND.terrain.patchCells;
  const values = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j += 1) {
    const y = (row * cells + j + .5) * cellMetres;
    for (let i = 0; i < cells; i += 1) values[j * cells + i] = heightAt((column * cells + i + .5) * cellMetres, y);
  }
  return encodePatch(column, row, values);
}

export function encodePatch(column, row, values) {
  let lowest = Infinity;
  let highest = -Infinity;
  for (const value of values) { lowest = Math.min(lowest, value); highest = Math.max(highest, value); }
  const stepMetres = Math.max(GROUND.terrain.minimumHeightStepMetres, (highest - lowest) / 0xffff);
  const steps = Uint16Array.from(values, value => clamp(Math.round((value - lowest) / stepMetres), 0, 0xffff));
  const bytes = new Uint8Array(steps.buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { column, row, baseMetres: lowest, stepMetres, heights: btoa(binary) };
}

export function decodePatch(patch) {
  const cells = GROUND.terrain.patchCells;
  const binary = atob(patch.heights);
  if (binary.length !== cells * cells * 2) throw new RangeError('A terrain patch does not match its grid.');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const steps = new Uint16Array(bytes.buffer);
  return Float32Array.from(steps, value => patch.baseMetres + value * patch.stepMetres);
}

/** The rectangle of patches a terrain holds; null when it holds none. */
export function terrainRange(terrain) {
  if (!terrain?.patches?.length) return null;
  const columns = terrain.patches.map(patch => patch.column);
  const rows = terrain.patches.map(patch => patch.row);
  return { column0: Math.min(...columns), column1: Math.max(...columns), row0: Math.min(...rows), row1: Math.max(...rows) };
}

const surfaces = new Map();
const MAXIMUM_CACHED_SURFACES = 4;

/** A 32-bit FNV-1a hash of a terrain's patches, so that surfaces are cached by their content. */
function terrainKey(terrain) {
  let hash = 0x811c9dc5;
  const mix = text => { for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193); };
  mix(`${terrain.cellMetres}|${terrain.datumMetres}|`);
  for (const patch of terrain.patches) { mix(`${patch.column},${patch.row},${patch.baseMetres},${patch.stepMetres}|`); mix(patch.heights); }
  return `${hash >>> 0}:${terrain.patches.length}`;
}

/**
 * The terrain surface of a scene: its patches put together, heights in the scene frame relative to
 * the datum (z = 0, the ground under the origin when the terrain was loaded), and above sea level.
 * Outside the patches the edge heights continue. Without terrain, or with it switched off, the
 * ground is the plane z = 0.
 */
export function terrainSurface(terrain) {
  if (!terrain?.enabled || !terrain.patches?.length) return FLAT_SURFACE;
  const key = terrainKey(terrain);
  const cached = surfaces.get(key);
  if (cached) return cached;
  const { cellMetres, datumMetres } = terrain;
  const range = terrainRange(terrain);
  const cells = GROUND.terrain.patchCells;
  const columns = (range.column1 - range.column0 + 1) * cells;
  const rows = (range.row1 - range.row0 + 1) * cells;
  const values = new Float32Array(columns * rows);
  for (const patch of terrain.patches) {
    const heights = decodePatch(patch);
    const left = (patch.column - range.column0) * cells;
    const bottom = (patch.row - range.row0) * cells;
    for (let j = 0; j < cells; j += 1) values.set(heights.subarray(j * cells, (j + 1) * cells), (bottom + j) * columns + left);
  }
  const bounds = rangeBounds(range, cellMetres);
  const sample = (x, y) => {
    const gridX = clamp((x - bounds.west) / cellMetres - .5, 0, columns - 1);
    const gridY = clamp((y - bounds.south) / cellMetres - .5, 0, rows - 1);
    const x0 = Math.min(columns - 2, Math.floor(gridX));
    const y0 = Math.min(rows - 2, Math.floor(gridY));
    const fx = gridX - x0;
    const fy = gridY - y0;
    const index = y0 * columns + x0;
    return (values[index] * (1 - fx) + values[index + 1] * fx) * (1 - fy) + (values[index + columns] * (1 - fx) + values[index + columns + 1] * fx) * fy;
  };
  const surface = {
    flat: false,
    datumMetres,
    cellMetres,
    /** Height of the ground above the datum. */
    heightAt: (x, y) => sample(x, y) - datumMetres,
    /** Unit upward normal of the ground, from central differences one cell wide. */
    normalAt: (x, y) => {
      const gx = (sample(x + cellMetres, y) - sample(x - cellMetres, y)) / (2 * cellMetres);
      const gy = (sample(x, y + cellMetres) - sample(x, y - cellMetres)) / (2 * cellMetres);
      const length = Math.hypot(gx, gy, 1);
      return { x: -gx / length, y: -gy / length, z: 1 / length };
    },
    /** The loaded rectangle of the scene frame; its grid's cell (0, 0) has its corner at west, south. */
    bounds,
    values,
    columns,
    rows
  };
  surfaces.set(key, surface);
  if (surfaces.size > MAXIMUM_CACHED_SURFACES) surfaces.delete(surfaces.keys().next().value);
  return surface;
}

export const FLAT_SURFACE = Object.freeze({
  flat: true,
  datumMetres: 0,
  cellMetres: Infinity,
  heightAt: () => 0,
  normalAt: () => ({ x: 0, y: 0, z: 1 }),
  bounds: null
});

/** A point stored above the ground under it, placed in the scene frame. */
export const onGround = (surface, point) => ({ x: point.x, y: point.y, z: surface.heightAt(point.x, point.y) + point.z });
