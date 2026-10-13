import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapLayer } from '../src/ui/map-layer.js';

test('map tiles work without terrain and settle when images arrive; checking visibility loads nothing', () => {
  const original = globalThis.Image;
  const images = [];
  globalThis.Image = class { set src(url) { if (url) images.push(this); } };
  try {
    const place = { latitude: 61.5, longitude: 23.8 };
    const area = { west: -8192, east: 8192, south: -8192, north: 8192 };
    let draws = 0;
    const layer = createMapLayer(draw);
    function draw() {
      draws++;
      layer.tiles(place, area);
      for (let name = 0; name < 30; name++) layer.tiles(place);
    }
    draw();
    const count = images.length;
    assert.ok(count > 0 && count <= 36);
    for (const image of images.slice()) image.onload();
    assert.equal(images.length, count, 'loaded tiles must not trigger another load cycle');
    assert.equal(draws, count + 1);
    assert.equal(layer.tiles(place, area).length, count);
    layer.tiles(place, { ...area, west: -4096 });
    layer.tiles(place, area);
    const afterPan = images.length;
    for (let repeat = 0; repeat < 10; repeat++) draw();
    assert.equal(images.length, afterPan, 'returning to the same view reuses tiles');
    layer.clear();
    assert.ok(images.every(image => !image.onload && !image.onerror));
  } finally { globalThis.Image = original; }
});
