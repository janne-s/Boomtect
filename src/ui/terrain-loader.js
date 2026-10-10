import { decodePngRgb } from '../domain/png.js';
import { buildHeightfield, decodeTerrarium, encodeHeights, TERRAIN_PROVIDER, terrainPlan, TILE_SIZE } from '../domain/terrain.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

/** The first place matching a search, from OpenStreetMap Nominatim, or null. */
export async function searchPlace(text, { signal } = {}) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('q', text);
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`The place search failed (${response.status}).`);
  const [first] = await response.json();
  return first ? { latitude: Number(first.lat), longitude: Number(first.lon), name: first.display_name } : null;
}

async function decodeTile(response) {
  const { width, height, rgb } = await decodePngRgb(await response.arrayBuffer());
  if (width !== TILE_SIZE || height !== TILE_SIZE) throw new Error('A terrain tile has an unexpected size.');
  const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let index = 0; index < elevations.length; index += 1) elevations[index] = decodeTerrarium(rgb[index * 3], rgb[index * 3 + 1], rgb[index * 3 + 2]);
  return elevations;
}

/**
 * Fetches the Terrarium tiles around a centre and returns the captured terrain for the scene.
 * Adapted from Echotect `captureTerrain` (commit cb712ef) to a square capture around a point.
 */
export async function captureTerrain({ latitude, longitude, extentMetres, cellMetres, place }, { signal, onProgress } = {}) {
  const plan = terrainPlan({ latitude, longitude, extentMetres, cellMetres });
  const { tiles, zoom } = plan;
  const entries = [];
  for (let y = tiles.north; y <= tiles.south; y += 1) for (let x = tiles.west; x <= tiles.east; x += 1) entries.push({ x, y });
  let done = 0;
  const decoded = await Promise.all(entries.map(async ({ x, y }) => {
    const url = TERRAIN_PROVIDER.url.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
    const response = await fetch(url, { signal, mode: 'cors' });
    if (!response.ok) throw new Error(`Terrain tile ${zoom}/${x}/${y} could not be loaded.`);
    const elevations = await decodeTile(response);
    done += 1;
    onProgress?.(done / entries.length);
    return { x, y, elevations };
  }));
  const byKey = new Map(decoded.map(tile => [`${tile.x}/${tile.y}`, tile.elevations]));
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const elevationAt = (pixelX, pixelY) => {
    const x = clamp(pixelX, tiles.west * TILE_SIZE, (tiles.east + 1) * TILE_SIZE - 1);
    const y = clamp(pixelY, tiles.north * TILE_SIZE, (tiles.south + 1) * TILE_SIZE - 1);
    return byKey.get(`${Math.floor(x / TILE_SIZE)}/${Math.floor(y / TILE_SIZE)}`)[(y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)];
  };
  const values = buildHeightfield(plan, elevationAt);
  return {
    enabled: true,
    shielding: true,
    place: (place ?? '').slice(0, 120),
    latitude,
    longitude,
    extentMetres: plan.extentMetres,
    cellMetres: plan.cellMetres,
    zoom,
    columns: plan.columns,
    rows: plan.rows,
    heights: encodeHeights(values)
  };
}
