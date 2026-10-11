import { GROUND } from '../domain/constants.js';
import { decodePngRgb } from '../domain/png.js';
import { PLACE_NAME_KINDS } from '../domain/scene.js';
import { buildPatch, curvatureDropMetres, decodeTerrarium, metresPerDegree, rangeBounds, TERRAIN_PROVIDER, terrainRange, tilePixel, tilePlan, TILE_SIZE } from '../domain/terrain.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const COORDINATES = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;
const searchCache = new Map();
let lastSearchAt = 0;

/**
 * The place a search names: coordinates written as "latitude, longitude", or the first match from
 * OpenStreetMap Nominatim, as in Echotect and GeoFlute. Searches are spaced a second apart and
 * remembered for the session. Null when nothing matches.
 */
export async function searchPlace(text, { signal } = {}) {
  const coordinates = text.match(COORDINATES);
  if (coordinates) {
    const latitude = Number(coordinates[1]);
    const longitude = Number(coordinates[2]);
    if (Math.abs(latitude) <= 85 && Math.abs(longitude) <= 180) return { latitude, longitude, name: `${latitude}, ${longitude}` };
  }
  const key = text.toLocaleLowerCase();
  if (searchCache.has(key)) return searchCache.get(key);
  const wait = Math.max(0, GROUND.terrain.searchIntervalMilliseconds - (Date.now() - lastSearchAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastSearchAt = Date.now();
  const url = new URL(NOMINATIM_URL);
  url.search = new URLSearchParams({ q: text, format: 'jsonv2', limit: '1', 'accept-language': 'en' });
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`The place search did not respond (${response.status}).`);
  const [first] = await response.json();
  const found = first ? { latitude: Number(first.lat), longitude: Number(first.lon), name: first.display_name } : null;
  searchCache.set(key, found);
  return found;
}

/**
 * Named places, peaks, and lakes inside a terrain's rectangle of patches, from OpenStreetMap through
 * the Overpass API, in the scene frame. Null when the service cannot be reached, so that names
 * already shown can be kept.
 */
export async function fetchPlaceNames(terrain, signal) {
  const { latitude, longitude } = terrain;
  const { north, east } = metresPerDegree(latitude);
  const bounds = rangeBounds(terrainRange(terrain), terrain.cellMetres);
  const box = [latitude + bounds.south / north, longitude + bounds.west / east, latitude + bounds.north / north, longitude + bounds.east / east].map(value => value.toFixed(6)).join(',');
  const query = `[out:json][timeout:25];(node["place"~"^(city|town|village|hamlet|locality)$"]["name"](${box});node["natural"="peak"]["name"](${box});way["natural"="water"]["name"](${box});relation["natural"="water"]["name"](${box}););out center ${GROUND.terrain.maximumPlaceNames};`;
  try {
    const response = await fetch(OVERPASS_URL, { method: 'POST', body: new URLSearchParams({ data: query }), signal });
    if (!response.ok) return null;
    const { elements = [] } = await response.json();
    return elements.flatMap(element => {
      const tags = element.tags ?? {};
      const kind = tags.natural === 'peak' ? 'peak' : tags.natural === 'water' ? 'water' : tags.place;
      const lat = element.lat ?? element.center?.lat;
      const lon = element.lon ?? element.center?.lon;
      if (!PLACE_NAME_KINDS.includes(kind) || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const x = (lon - longitude) * east;
      const y = (lat - latitude) * north;
      if (x < bounds.west || x > bounds.east || y < bounds.south || y > bounds.north) return [];
      const elevation = Number.parseFloat(tags.ele);
      return [{ name: (tags.name ?? '').slice(0, 80), kind, x, y, elevationMetres: kind === 'peak' && Number.isFinite(elevation) ? elevation : null }];
    }).filter(item => item.name).slice(0, GROUND.terrain.maximumPlaceNames);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function decodeTile(response) {
  const { width, height, rgb } = await decodePngRgb(await response.arrayBuffer());
  if (width !== TILE_SIZE || height !== TILE_SIZE) throw new Error('A terrain tile has an unexpected size.');
  const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let index = 0; index < elevations.length; index += 1) elevations[index] = decodeTerrarium(rgb[index * 3], rgb[index * 3 + 1], rgb[index * 3 + 2]);
  return elevations;
}

/**
 * Fetches terrain patches (`terrain.js`) of a cell size around the scene origin at `latitude`,
 * `longitude`: each from the Terrarium tiles that cover it, at the coarsest zoom whose pixels are no
 * larger than the cell, tiles shared between patches fetched once. Heights are lowered onto the
 * tangent plane at the origin. Adapted from Echotect `captureTerrain` (commit cb712ef).
 */
export async function capturePatches(anchor, cellMetres, wanted, { signal, onProgress } = {}) {
  const tiles = new Map();
  const plans = wanted.map(({ column, row }) => {
    const plan = tilePlan(anchor, rangeBounds({ column0: column, column1: column, row0: row, row1: row }, cellMetres), cellMetres);
    for (let y = plan.tiles.north; y <= plan.tiles.south; y += 1) for (let x = plan.tiles.west; x <= plan.tiles.east; x += 1) tiles.set(`${plan.zoom}/${x}/${y}`, null);
    return { column, row, plan };
  });
  let done = 0;
  await Promise.all([...tiles.keys()].map(async key => {
    const [zoom, x, y] = key.split('/');
    const url = TERRAIN_PROVIDER.url.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
    const response = await fetch(url, { signal, mode: 'cors' });
    if (!response.ok) throw new Error(`Terrain tile ${key} could not be loaded.`);
    tiles.set(key, await decodeTile(response));
    done += 1;
    onProgress?.(done / tiles.size);
  }));
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  return plans.map(({ column, row, plan }) => {
    const { zoom, tiles: range } = plan;
    const elevationAt = (pixelX, pixelY) => {
      const x = clamp(pixelX, range.west * TILE_SIZE, (range.east + 1) * TILE_SIZE - 1);
      const y = clamp(pixelY, range.north * TILE_SIZE, (range.south + 1) * TILE_SIZE - 1);
      return tiles.get(`${zoom}/${Math.floor(x / TILE_SIZE)}/${Math.floor(y / TILE_SIZE)}`)[(y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)];
    };
    return buildPatch(column, row, cellMetres, (x, y) => {
      const pixel = tilePixel(anchor, x, y, zoom);
      const x0 = Math.floor(pixel.x);
      const y0 = Math.floor(pixel.y);
      const fx = pixel.x - x0;
      const fy = pixel.y - y0;
      const elevation = (elevationAt(x0, y0) * (1 - fx) + elevationAt(x0 + 1, y0) * fx) * (1 - fy)
        + (elevationAt(x0, y0 + 1) * (1 - fx) + elevationAt(x0 + 1, y0 + 1) * fx) * fy;
      return elevation - curvatureDropMetres(Math.hypot(x, y));
    });
  });
}
