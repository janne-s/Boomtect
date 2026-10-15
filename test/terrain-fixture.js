import { GROUND } from '../src/domain/constants.js';
import { DEFAULT_PLACE, TERRAIN_DEFAULTS } from '../src/domain/scene.js';
import { buildPatch, patchRange, rangePatches } from '../src/domain/terrain.js';

export function syntheticTerrain(height, { cells = 100, extentMetres = 4000, ...settings } = {}) {
  const half = extentMetres / 2;
  const perSide = Math.ceil(half / (GROUND.terrain.patchCells * extentMetres / cells));
  const cellMetres = half / (perSide * GROUND.terrain.patchCells);
  const patches = rangePatches(patchRange({ west: -half, east: half, south: -half, north: half }, cellMetres)).map(({ column, row }) => buildPatch(column, row, cellMetres, height));
  return { ...TERRAIN_DEFAULTS, ...settings, names: [], latitude: DEFAULT_PLACE.latitude, longitude: DEFAULT_PLACE.longitude, cellMetres, datumMetres: height(0, 0), patches };
}
