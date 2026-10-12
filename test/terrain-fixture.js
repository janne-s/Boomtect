import { GROUND } from '../src/domain/constants.js';
import { DEFAULT_PLACE, TERRAIN_DEFAULTS } from '../src/domain/scene.js';
import { buildPatch, patchRange, rangePatches } from '../src/domain/terrain.js';

/**
 * Terrain with heights from height(x, y) in metres above sea level over exactly the square of
 * `extentMetres` around the origin, in whole patches: the cell is extentMetres / cells or finer, so
 * that the half side is a whole number of patches, at the default place. Its datum is height(0, 0).
 */
export function syntheticTerrain(height, { cells = 100, extentMetres = 4000, ...settings } = {}) {
  const half = extentMetres / 2;
  const perSide = Math.ceil(half / (GROUND.terrain.patchCells * extentMetres / cells));
  const cellMetres = half / (perSide * GROUND.terrain.patchCells);
  const patches = rangePatches(patchRange({ west: -half, east: half, south: -half, north: half }, cellMetres)).map(({ column, row }) => buildPatch(column, row, cellMetres, height));
  return { ...TERRAIN_DEFAULTS, ...settings, names: [], latitude: DEFAULT_PLACE.latitude, longitude: DEFAULT_PLACE.longitude, cellMetres, datumMetres: height(0, 0), patches };
}
