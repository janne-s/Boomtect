import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBlast, defaultCloudFlash, defaultScene, defaultStorm, parseScene, SceneError, serializeScene } from '../src/domain/scene.js';

test('the default scene is valid and round-trips without loss', () => {
  const scene = defaultScene();
  assert.deepEqual(parseScene(scene), scene);
  assert.deepEqual(parseScene(JSON.parse(serializeScene(scene))), scene);
});

test('every emitter kind validates and round-trips in its mode', () => {
  const thunder = { ...defaultScene('thunder'), emitters: [defaultScene().emitters[0], defaultCloudFlash(), defaultStorm()] };
  assert.deepEqual(parseScene(JSON.parse(serializeScene(thunder))), thunder);
  const blast = defaultScene('blast');
  assert.deepEqual(parseScene(JSON.parse(serializeScene(blast))), blast);
});

test('an emitter outside its mode is rejected', () => {
  assert.throws(() => parseScene({ ...defaultScene('thunder'), emitters: [defaultBlast()] }), SceneError);
  assert.throws(() => parseScene({ ...defaultScene('blast'), emitters: [defaultStorm()] }), SceneError);
  assert.throws(() => parseScene({ ...defaultScene(), mode: 'opera' }), SceneError);
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

test('a new scene listens binaurally facing its emitter, and microphones added later are omni', async () => {
  const { defaultReceiver, emitterAnchor, headingToward, MODES } = await import('../src/domain/scene.js');
  for (const mode of MODES) {
    const scene = defaultScene(mode);
    const [receiver] = scene.receivers;
    assert.equal(receiver.type, 'binaural');
    assert.equal(receiver.headingDegrees, headingToward(receiver.positionMetres, emitterAnchor(scene.emitters[0])));
  }
  assert.equal(defaultReceiver('receiver-2', 'Mic 2').type, 'omni');
  assert.equal(headingToward({ x: 0, y: 0 }, { x: 0, y: 10 }), 0);
  assert.equal(headingToward({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);
  assert.equal(headingToward({ x: 5, y: 5 }, { x: 0, y: 5 }), 270);
});
