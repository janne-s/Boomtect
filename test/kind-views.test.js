import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultMeteor, defaultShower } from '../src/domain/scene.js';
import { cachedTracks } from '../src/ui/geometry-cache.js';
import { kindViews } from '../src/ui/kind-views.js';
import { plainScene } from './plain-scene.js';

for (const emitter of [defaultMeteor(), defaultShower()]) {
  test(`${emitter.kind} paths draw with finite positions and their configured speed`, () => {
    const scene = plainScene('sonic');
    let strokes = 0;
    let points = 0;
    const context = {
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() { strokes += 1; }
    };
    const tools = {
      scene,
      frame: {
        project(point) {
          assert.ok(['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])));
          points += 1;
          return { x: point.x, y: point.z };
        }
      }
    };
    kindViews()[emitter.kind].draw(context, emitter, tools, { colors: { end: '#777' }, selected: false });
    const paths = cachedTracks(emitter, scene.air);
    assert.equal(strokes, emitter.meteorCount ?? 1);
    assert.equal(points, paths.reduce((sum, path) => sum + path.seconds.length, 0));
    for (const path of paths) {
      assert.equal(path.speed.length, path.seconds.length);
      assert.ok(path.speed.every(speed => speed === emitter.speedKilometresPerSecond * 1000));
      const distance = Math.hypot(path.x[1] - path.x[0], path.y[1] - path.y[0], path.z[1] - path.z[0]);
      assert.ok(Math.abs(distance / path.step - path.speed[0]) < 1e-6);
    }
  });
}
