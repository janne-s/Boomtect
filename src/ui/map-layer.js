import { VIEW } from '../domain/constants.js';
import { mapTiles, rangeBounds, terrainRange } from '../domain/terrain.js';
import { palette } from './canvas.js';

/** OpenTopoMap: topographic tiles over OpenStreetMap data, as Echotect and GeoFlute use. */
const TILE_URL = 'https://tile.opentopomap.org/{z}/{x}/{y}.png';

const rgb = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));

/**
 * A tile in Boomtect's palette: its lightness turned over, so that the light map lies dark on the
 * panel's ground and its lines and lettering show in the muted ink, and water as a dim shift
 * toward the colour of water names. Drawn once per tile into a canvas of its own.
 */
function styledTile(image) {
  const colors = palette();
  const ground = rgb(colors.ground);
  const ink = rgb(colors.muted);
  const water = rgb(colors.direct);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  for (let at = 0; at < data.length; at += 4) {
    const [r, g, b] = [data[at], data[at + 1], data[at + 2]];
    const light = (.299 * r + .587 * g + .114 * b) / 255;
    // Contours and lettering are the dark parts; light land is the ground.
    const line = Math.min(1, Math.max(0, (VIEW.map.lightLand - light) / (VIEW.map.lightLand - VIEW.map.darkLine)));
    // Water is the blue that is bluer than it is red and no less blue than green.
    const wet = b - r > VIEW.map.waterBlue && b >= g;
    for (let channel = 0; channel < 3; channel += 1) {
      data[at + channel] = ground[channel] + ((wet ? water[channel] : ink[channel]) - ground[channel]) * (wet ? VIEW.map.waterShare : line);
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * The map laid on the floor of a terrain: its tiles, loaded on first use and again when its patches change.
 * `onLoad` runs as each tile arrives, so the view can draw it. A tile that fails stays empty.
 */
export function createMapLayer(onLoad) {
  let key = null;
  let tiles = [];

  const terrainKey = terrain => {
    const range = terrainRange(terrain);
    return `${terrain.latitude},${terrain.longitude},${terrain.cellMetres},${range.column0},${range.column1},${range.row0},${range.row1}`;
  };

  function load(terrain) {
    key = terrainKey(terrain);
    const bounds = rangeBounds(terrainRange(terrain), terrain.cellMetres);
    tiles = mapTiles({ latitude: terrain.latitude, longitude: terrain.longitude, bounds }).tiles.map(tile => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      const entry = { ...tile, image, ready: false };
      const current = key;
      image.onload = () => {
        if (current !== key) return;
        // A tile that cannot be read (no CORS) is drawn as it is.
        try { entry.image = styledTile(image); } catch { /* Drawn unstyled. */ }
        entry.ready = true;
        onLoad();
      };
      image.src = TILE_URL.replace('{z}', tile.zoom).replace('{x}', tile.x).replace('{y}', tile.y);
      return entry;
    });
  }

  return {
    tiles(terrain) {
      if (!terrain?.patches?.length) return [];
      if (key !== terrainKey(terrain)) load(terrain);
      return tiles.filter(tile => tile.ready);
    }
  };
}
