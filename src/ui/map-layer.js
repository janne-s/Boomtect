import { mapTiles } from '../domain/terrain.js';

/** OpenTopoMap: topographic tiles over OpenStreetMap data, as Echotect and GeoFlute use. */
const TILE_URL = 'https://tile.opentopomap.org/{z}/{x}/{y}.png';

/**
 * The map laid on the floor of a terrain: its tiles, loaded on first use and kept per terrain.
 * `onLoad` runs as each tile arrives, so the view can draw it. A tile that fails stays empty.
 */
export function createMapLayer(onLoad) {
  let key = null;
  let tiles = [];

  function load(terrain) {
    key = `${terrain.latitude},${terrain.longitude},${terrain.extentMetres}`;
    tiles = mapTiles(terrain).tiles.map(tile => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      const entry = { ...tile, image, ready: false };
      const current = key;
      image.onload = () => { if (current !== key) return; entry.ready = true; onLoad(); };
      image.src = TILE_URL.replace('{z}', tile.zoom).replace('{x}', tile.x).replace('{y}', tile.y);
      return entry;
    });
  }

  return {
    /** The loaded tiles of a terrain, starting their requests when the terrain is new. */
    tiles(terrain) {
      if (!terrain?.latitude) return [];
      if (key !== `${terrain.latitude},${terrain.longitude},${terrain.extentMetres}`) load(terrain);
      return tiles.filter(tile => tile.ready);
    }
  };
}
