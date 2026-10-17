import { VIEW } from '../domain/constants.js';
import { mapTiles } from '../domain/terrain.js';
import { palette } from './canvas.js';

const TILE_URL = 'https://tile.opentopomap.org/{z}/{x}/{y}.png';

const rgb = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));

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
    const line = Math.min(1, Math.max(0, (VIEW.map.lightLand - light) / (VIEW.map.lightLand - VIEW.map.darkLine)));
    const wet = b - r > VIEW.map.waterBlue && b >= g;
    for (let channel = 0; channel < 3; channel += 1) {
      data[at + channel] = ground[channel] + ((wet ? water[channel] : ink[channel]) - ground[channel]) * (wet ? VIEW.map.waterShare : line);
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

export function createMapLayer(onLoad) {
  let key = null;
  let anchorKey = null;
  let tiles = [];
  let previous = [];
  let active = new Set();
  const cache = new Map();

  function load(anchor, bounds) {
    const location = `${anchor.latitude},${anchor.longitude}`;
    const ready = tiles.filter(tile => tile.ready);
    if (location !== anchorKey) previous = [];
    else if (ready.length) previous = ready;
    anchorKey = location;
    const plan = mapTiles({ ...anchor, bounds, pixelMetres: bounds.pixelMetres ?? null, maximumTiles: VIEW.map.maximumTiles }).tiles;
    active = new Set(plan.map(tile => `${tile.zoom}/${tile.x}/${tile.y}`));
    tiles = plan.map(tile => {
      const id = `${tile.zoom}/${tile.x}/${tile.y}`;
      let entry = cache.get(id);
      if (entry) {
        cache.delete(id);
        cache.set(id, entry);
        return { ...tile, get image() { return entry.image; }, get ready() { return entry.ready; }, get finished() { return entry.finished; } };
      }
      const image = new Image();
      image.crossOrigin = 'anonymous';
      entry = { image, ready: false, finished: false };
      cache.set(id, entry);
      image.onload = () => {
        try { entry.image = styledTile(image); } catch {}
        entry.ready = true;
        entry.finished = true;
        if (active.has(id)) onLoad();
      };
      const url = TILE_URL.replace('{z}', tile.zoom).replace('{x}', tile.x).replace('{y}', tile.y);
      image.onerror = () => {
        if (!entry.retried) {
          entry.retried = true;
          entry.timer = setTimeout(() => { if (cache.get(id) === entry) image.src = `${url}?retry`; }, VIEW.map.retryMilliseconds);
          return;
        }
        entry.finished = true;
        if (active.has(id)) onLoad();
      };
      image.src = url;
      return { ...tile, get image() { return entry.image; }, get ready() { return entry.ready; }, get finished() { return entry.finished; } };
    });
    for (const [id, entry] of cache) {
      if (cache.size <= VIEW.map.cachedTiles) break;
      if (active.has(id)) continue;
      entry.image.onload = null;
      entry.image.onerror = null;
      clearTimeout(entry.timer);
      if (!entry.finished) entry.image.src = '';
      cache.delete(id);
    }
  }

  return {
    tiles(anchor, area) {
      if (!area) return [];
      const bounds = area;
      const next = [anchor.latitude, anchor.longitude, bounds.west, bounds.east, bounds.south, bounds.north, bounds.pixelMetres].join(',');
      if (key !== next) {
        key = next;
        load(anchor, bounds);
      }
      const ready = tiles.filter(tile => tile.ready);
      return tiles.every(tile => tile.finished) ? ready : [...previous, ...ready];
    },
    clear() {
      active.clear();
      for (const entry of cache.values()) {
        entry.image.onload = null;
        entry.image.onerror = null;
        clearTimeout(entry.timer);
        if (!entry.finished) entry.image.src = '';
      }
      cache.clear();
      key = anchorKey = null;
      tiles = previous = [];
    }
  };
}
