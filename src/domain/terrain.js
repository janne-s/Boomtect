import { GROUND, VIEW } from './constants.js';

/**
 * Terrain from Terrarium elevation tiles as a heightfield in the scene frame: x east and y north
 * in metres from the scene origin at the capture centre, row 0 in the south. Heights are metres
 * above sea level, lowered onto the tangent plane at the centre for the Earth's curvature.
 *
 * Adopted from Echotect `src/terrain-tiles.js` and `src/terrain-space.js` at commit cb712ef
 * (tile arithmetic, Terrarium decoding, the capture plan, the heightfield resampling, and the
 * base64 encoding), with Boomtect's units and a square capture around a centre point.
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

/** Drop of a level surface below the tangent plane at the capture centre, in metres. */
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
 * The map tiles covering a terrain square, each with its north-west, north-east, and south-west
 * corners in the scene frame (x east, y north, metres from the centre). The zoom is the finest at
 * which about VIEW.map.pixelsAcross pixels span the square, within GROUND.terrain.maximumTileRequests tiles.
 */
export function mapTiles({ latitude, longitude, extentMetres }) {
  const { north, east } = metresPerDegree(latitude);
  const half = extentMetres / 2;
  const bounds = { west: longitude - half / east, east: longitude + half / east, south: latitude - half / north, north: latitude + half / north };
  let zoom = VIEW.map.maximumZoom;
  while (zoom > MINIMUM_TILE_ZOOM && (tilePixelMetres(latitude, zoom) < extentMetres / VIEW.map.pixelsAcross || tileRange(bounds, zoom).count > GROUND.terrain.maximumTileRequests)) zoom -= 1;
  const range = tileRange(bounds, zoom);
  const local = (x, y) => ({ x: ((x / 2 ** zoom) * 360 - 180 - longitude) * east, y: (tileLatitude(y, zoom) - latitude) * north });
  const tiles = [];
  for (let y = range.north; y <= range.south; y += 1) {
    for (let x = range.west; x <= range.east; x += 1) tiles.push({ x, y, zoom, northWest: local(x, y), northEast: local(x + 1, y), southWest: local(x, y + 1) });
  }
  return { zoom, tiles };
}

/**
 * The tiles and grid for a square capture of `extentMetres` around a centre. The tiles are the
 * coarsest whose pixels are no larger than the cell, within GROUND.terrain.maximumTileRequests; the cell grows
 * if the grid would exceed GROUND.terrain.maximumGridCells on a side.
 */
export function terrainPlan({ latitude, longitude, extentMetres, cellMetres }) {
  const { north, east } = metresPerDegree(latitude);
  const half = extentMetres / 2;
  const bounds = { west: longitude - half / east, east: longitude + half / east, south: latitude - half / north, north: latitude + half / north };
  const cell = Math.max(cellMetres, extentMetres / GROUND.terrain.maximumGridCells);
  let zoom = MAXIMUM_TILE_ZOOM;
  while (zoom > MINIMUM_TILE_ZOOM && tilePixelMetres(latitude, zoom - 1) <= cell) zoom -= 1;
  while (zoom > MINIMUM_TILE_ZOOM && tileRange(bounds, zoom).count > GROUND.terrain.maximumTileRequests) zoom -= 1;
  const cells = Math.max(2, Math.round(extentMetres / cell));
  return { latitude, longitude, extentMetres, cellMetres: extentMetres / cells, columns: cells, rows: cells, zoom, tiles: tileRange(bounds, zoom) };
}

/**
 * Samples decoded tiles at the grid's cell centres in the scene frame and lowers every sample onto
 * the tangent plane at the centre. `elevationAt(tilePixelX, tilePixelY)` reads the tile mosaic in
 * global pixels at the plan's zoom.
 */
export function buildHeightfield(plan, elevationAt) {
  const { columns, rows, cellMetres, zoom, latitude, longitude } = plan;
  const values = new Float32Array(columns * rows);
  const { north, east } = metresPerDegree(latitude);
  for (let row = 0; row < rows; row += 1) {
    const y = (row + .5 - rows / 2) * cellMetres;
    const pixelY = tileY(latitude + y / north, zoom) * TILE_SIZE - .5;
    for (let column = 0; column < columns; column += 1) {
      const x = (column + .5 - columns / 2) * cellMetres;
      const pixelX = tileX(longitude + x / east, zoom) * TILE_SIZE - .5;
      const x0 = Math.floor(pixelX);
      const y0 = Math.floor(pixelY);
      const fx = pixelX - x0;
      const fy = pixelY - y0;
      const elevation = (elevationAt(x0, y0) * (1 - fx) + elevationAt(x0 + 1, y0) * fx) * (1 - fy)
        + (elevationAt(x0, y0 + 1) * (1 - fx) + elevationAt(x0 + 1, y0 + 1) * fx) * fy;
      values[row * columns + column] = elevation - curvatureDropMetres(Math.hypot(x, y));
    }
  }
  return values;
}

export function encodeHeights(values) {
  const bytes = new Uint8Array(Float32Array.from(values).buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function decodeHeights(text, expectedLength) {
  const binary = atob(text);
  if (binary.length !== expectedLength * 4) throw new RangeError('The terrain heights do not match their grid.');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Float32Array(bytes.buffer);
}

const surfaces = new Map();
const MAXIMUM_CACHED_SURFACES = 4;

/**
 * The terrain surface of a scene: heights in the scene frame, relative to the ground at the origin
 * (the datum, z = 0), and above sea level. Outside the capture the edge heights continue. Without
 * terrain, or with it switched off, the ground is the plane z = 0.
 */
export function terrainSurface(terrain) {
  if (!terrain?.enabled) return FLAT_SURFACE;
  const cached = surfaces.get(terrain.heights);
  if (cached) return cached;
  const { columns, rows, cellMetres } = terrain;
  const values = decodeHeights(terrain.heights, columns * rows);
  const sample = (x, y) => {
    const gridX = clamp(x / cellMetres + columns / 2 - .5, 0, columns - 1);
    const gridY = clamp(y / cellMetres + rows / 2 - .5, 0, rows - 1);
    const x0 = Math.min(columns - 2, Math.floor(gridX));
    const y0 = Math.min(rows - 2, Math.floor(gridY));
    const fx = gridX - x0;
    const fy = gridY - y0;
    const index = y0 * columns + x0;
    return (values[index] * (1 - fx) + values[index + 1] * fx) * (1 - fy) + (values[index + columns] * (1 - fx) + values[index + columns + 1] * fx) * fy;
  };
  const datum = sample(0, 0);
  const surface = {
    flat: false,
    datumMetres: datum,
    cellMetres,
    /** Height of the ground above the datum. */
    heightAt: (x, y) => sample(x, y) - datum,
    /** Unit upward normal of the ground, from central differences one cell wide. */
    normalAt: (x, y) => {
      const gx = (sample(x + cellMetres, y) - sample(x - cellMetres, y)) / (2 * cellMetres);
      const gy = (sample(x, y + cellMetres) - sample(x, y - cellMetres)) / (2 * cellMetres);
      const length = Math.hypot(gx, gy, 1);
      return { x: -gx / length, y: -gy / length, z: 1 / length };
    },
    halfExtentMetres: columns * cellMetres / 2,
    values,
    columns,
    rows
  };
  surfaces.set(terrain.heights, surface);
  if (surfaces.size > MAXIMUM_CACHED_SURFACES) surfaces.delete(surfaces.keys().next().value);
  return surface;
}

export const FLAT_SURFACE = Object.freeze({
  flat: true,
  datumMetres: 0,
  cellMetres: Infinity,
  heightAt: () => 0,
  normalAt: () => ({ x: 0, y: 0, z: 1 }),
  halfExtentMetres: 0
});

/** A point stored above the ground under it, placed in the scene frame. */
export const onGround = (surface, point) => ({ x: point.x, y: point.y, z: surface.heightAt(point.x, point.y) + point.z });
