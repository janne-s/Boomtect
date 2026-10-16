import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBlast, defaultCloudFlash, defaultScene, defaultStorm, parseScene, SceneError, serializeScene } from '../src/domain/scene.js';
import { encodeFloat32Wav, wavByteLength } from '../src/shared/domain/wav.js';

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

test('WAV header declares mono float32 at the given rate and keeps samples unchanged', () => {
  const samples = Float32Array.from([0, .5, -2, 1e-3]);
  const view = new DataView(encodeFloat32Wav([samples], 48000));
  assert.equal(view.getUint16(20, true), 3);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 32);
  assert.equal(view.getUint32(40, true), 16);
  assert.equal(view.getFloat32(44 + 8, true), -2);
  assert.equal(view.byteLength, wavByteLength(4, 1));
});

test('WAV of more than two channels is WAVE_FORMAT_EXTENSIBLE with an IEEE float subformat and no speaker positions', () => {
  const channels = [0, 1, 2, 3].map(channel => Float32Array.from([channel, -channel / 2, .25]));
  const buffer = encodeFloat32Wav(channels, 48000);
  const view = new DataView(buffer);
  const text = (offset, length) => String.fromCharCode(...new Uint8Array(buffer, offset, length));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), buffer.byteLength - 8);
  assert.equal(text(12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 40);
  assert.equal(view.getUint16(20, true), 0xfffe);
  assert.equal(view.getUint16(22, true), 4);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 48000 * 16);
  assert.equal(view.getUint16(32, true), 16);
  assert.equal(view.getUint16(34, true), 32);
  assert.equal(view.getUint16(36, true), 22);
  assert.equal(view.getUint16(38, true), 32);
  assert.equal(view.getUint32(40, true), 0);
  assert.deepEqual([...new Uint8Array(buffer, 44, 16)], [0x03, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]);
  assert.equal(text(60, 4), 'data');
  assert.equal(view.getUint32(64, true), 3 * 16);
  assert.equal(buffer.byteLength, wavByteLength(3, 4));
  // Frame 1, channel 3, interleaved after the 68-byte header.
  assert.equal(view.getFloat32(68 + 16 + 12, true), -1.5);
});

test('a stereo WAV keeps the plain IEEE float format', () => {
  const view = new DataView(encodeFloat32Wav([new Float32Array(2), new Float32Array(2)], 44100));
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 3);
  assert.equal(view.byteLength, wavByteLength(2, 2));
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
