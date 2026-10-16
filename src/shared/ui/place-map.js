import { VIEW } from '../domain/constants.js';
import { fitCanvas, palette } from './canvas.js';
import { tilePixelMetres, tileX, tileY } from '../domain/terrain.js';

const TILE_SIZE = 256;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export function createPlaceMap(mapCanvas, overlayCanvas, { onChange }) {
  let centre = { latitude: 61.5, longitude: 23.8 };
  let zoom = 11;
  let extentMetres = 5000;
  const tiles = new Map();
  const pointers = new Map();
  let pinch = null;

  const pixel = (latitude, longitude, level) => ({ x: tileX(longitude, level) * TILE_SIZE, y: tileY(latitude, level) * TILE_SIZE });

  function unproject(x, y, level) {
    const scale = TILE_SIZE * 2 ** level;
    const longitude = x / scale * 360 - 180;
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI;
    return { latitude: Math.max(-85, Math.min(85, latitude)), longitude: ((longitude + 540) % 360) - 180 };
  }

  function tile(level, x, y) {
    const key = `${level}/${x}/${y}`;
    if (!tiles.has(key)) {
      const image = new Image();
      image.addEventListener('load', draw);
      image.src = TILE_URL.replace('{z}', level).replace('{x}', x).replace('{y}', y);
      tiles.set(key, image);
    }
    return tiles.get(key);
  }

  function draw() {
    if (!mapCanvas.isConnected || mapCanvas.clientWidth === 0) return;
    const { context, width, height } = fitCanvas(mapCanvas);
    const level = Math.max(VIEW.placeMap.minimumZoom, Math.min(VIEW.placeMap.maximumZoom, Math.floor(zoom)));
    const scale = 2 ** (zoom - level);
    const middle = pixel(centre.latitude, centre.longitude, level);
    const left = middle.x - width / 2 / scale;
    const top = middle.y - height / 2 / scale;
    const count = 2 ** level;
    for (let ty = Math.floor(top / TILE_SIZE); ty * TILE_SIZE < top + height / scale; ty += 1) {
      if (ty < 0 || ty >= count) continue;
      for (let tx = Math.floor(left / TILE_SIZE); tx * TILE_SIZE < left + width / scale; tx += 1) {
        const image = tile(level, ((tx % count) + count) % count, ty);
        if (!image.complete || !image.naturalWidth) continue;
        context.drawImage(image, (tx * TILE_SIZE - left) * scale, (ty * TILE_SIZE - top) * scale, TILE_SIZE * scale + .5, TILE_SIZE * scale + .5);
      }
    }
    drawOverlay();
  }

  function drawOverlay() {
    const { context, width, height } = fitCanvas(overlayCanvas);
    const colors = palette();
    const metresPerPixel = tilePixelMetres(centre.latitude, zoom);
    const side = extentMetres / metresPerPixel;
    context.strokeStyle = colors.accent;
    context.lineWidth = 1.5;
    context.strokeRect(width / 2 - side / 2, height / 2 - side / 2, side, side);
    context.beginPath();
    context.moveTo(width / 2 - 6, height / 2); context.lineTo(width / 2 + 6, height / 2);
    context.moveTo(width / 2, height / 2 - 6); context.lineTo(width / 2, height / 2 + 6);
    context.stroke();
  }

  function moveBy(dx, dy) {
    const middle = pixel(centre.latitude, centre.longitude, zoom);
    centre = unproject(middle.x - dx, middle.y - dy, zoom);
    draw();
    onChange?.(centre);
  }

  function zoomBy(factor) {
    zoom = Math.max(VIEW.placeMap.minimumZoom, Math.min(VIEW.placeMap.maximumZoom, zoom + Math.log2(factor)));
    draw();
  }

  overlayCanvas.addEventListener('pointerdown', event => {
    overlayCanvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  overlayCanvas.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      zoomBy(distance / pinch);
      pinch = distance;
      return;
    }
    moveBy(event.clientX - previous.x, event.clientY - previous.y);
  });
  const release = event => { pointers.delete(event.pointerId); if (pointers.size < 2) pinch = null; };
  overlayCanvas.addEventListener('pointerup', release);
  overlayCanvas.addEventListener('pointercancel', release);
  overlayCanvas.addEventListener('wheel', event => {
    event.preventDefault();
    zoomBy(2 ** (-event.deltaY * VIEW.placeMap.zoomPerPixel));
  }, { passive: false });
  new ResizeObserver(draw).observe(mapCanvas);

  return {
    show(next, extent) {
      centre = { latitude: next.latitude, longitude: next.longitude };
      extentMetres = extent;
      const width = mapCanvas.clientWidth || 600;
      zoom = Math.max(VIEW.placeMap.minimumZoom, Math.min(VIEW.placeMap.maximumZoom, Math.log2(tilePixelMetres(centre.latitude, 0) * width / (extent * 2.5))));
      draw();
    },
    centre: () => ({ ...centre }),
    draw
  };
}
