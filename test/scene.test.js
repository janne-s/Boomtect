import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBlast, defaultCloudFlash, defaultScene, defaultStorm, parseScene, SceneError, serializeScene } from '../src/domain/scene.js';
import { encodeFloat32Wav } from '../src/domain/wav.js';

test('the default scene is valid and round-trips without loss', () => {
  const scene = defaultScene();
  assert.deepEqual(parseScene(scene), scene);
  assert.deepEqual(parseScene(JSON.parse(serializeScene(scene))), scene);
});

test('every emitter kind validates and round-trips', () => {
  const scene = { ...defaultScene(), emitters: [defaultScene().emitters[0], defaultCloudFlash(), defaultStorm(), defaultBlast()] };
  assert.deepEqual(parseScene(JSON.parse(serializeScene(scene))), scene);
});

test('invalid scenes are rejected with a reason', () => {
  const cases = [
    scene => { scene.format = 'other'; },
    scene => { scene.air.temperatureCelsius = 100; },
    scene => { scene.ground.type = 'lava'; },
    scene => { scene.emitters.push({ ...scene.emitters[0] }); },
    scene => { scene.emitters[0].flashType = 'sheet'; },
    scene => { scene.emitters[0].straightLengthMetres = 20; },
    scene => { scene.emitters = [{ ...defaultStorm(), cloudTopMetres: 1500 }]; },
    scene => { scene.emitters = [{ ...defaultStorm(), centreMetres: { x: 0, y: 0, z: 10 } }]; },
    scene => { scene.emitters[0].seed = -1; },
    scene => { scene.receivers[0].positionMetres.z = -1; },
    scene => { scene.emitters[0].strokeCount = 1.5; },
    scene => { scene.emitters[0].baseMetres = { x: 0, y: 0, z: 100 }; },
    scene => { scene.emitters[0].topMetres = { ...scene.emitters[0].baseMetres }; },
    scene => { scene.receivers = []; }
  ];
  for (const change of cases) {
    const scene = defaultScene();
    change(scene);
    assert.throws(() => parseScene(scene), SceneError);
  }
});

test('WAV header declares mono float32 at the given rate and keeps samples unchanged', () => {
  const samples = Float32Array.from([0, .5, -2, 1e-3]);
  const view = new DataView(encodeFloat32Wav([samples], 48000));
  assert.equal(view.getUint16(20, true), 3);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 32);
  assert.equal(view.getUint32(40, true), 16);
  assert.equal(view.getFloat32(44 + 8, true), -2);
});
