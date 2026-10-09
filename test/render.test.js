import assert from 'node:assert/strict';
import test from 'node:test';
import { speedOfSoundMetresPerSecond } from '../src/domain/air.js';
import { sphericalReflectionCoefficient } from '../src/domain/ground.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultBlast, defaultLightning, defaultReceiver, defaultScene, parseScene } from '../src/domain/scene.js';

function scene({ emitter, receivers, ground = { enabled: false, type: 'rigid' }, absorption = false }) {
  const base = defaultScene();
  return parseScene({ ...base, air: { ...base.air, absorption }, ground, emitters: [emitter], receivers });
}

const receiverAt = (id, positionMetres) => ({ ...defaultReceiver(id, id), positionMetres });

function render(value, index = 0) {
  return renderReceiver(prepareScene(value), value.receivers[index], value);
}

function peak(result, fromSeconds = -Infinity, toSeconds = Infinity) {
  let best = { value: 0, seconds: 0 };
  result.samples.forEach((value, index) => {
    const seconds = result.startSeconds + index / result.sampleRate;
    if (seconds >= fromSeconds && seconds <= toSeconds && Math.abs(value) > Math.abs(best.value)) best = { value, seconds };
  });
  return best;
}

const smallBlast = position => ({ ...defaultBlast(), chargeKilograms: .01, positionMetres: position });

test('a point blast arrives at R/c and falls off as 1/R', () => {
  const value = scene({ emitter: smallBlast({ x: 0, y: 0, z: 10 }), receivers: [receiverAt('near', { x: 300, y: 0, z: 10 }), receiverAt('far', { x: 600, y: 0, z: 10 })] });
  const speed = speedOfSoundMetresPerSecond(value.air.temperatureCelsius);
  const near = peak(render(value, 0));
  const far = peak(render(value, 1));
  assert.ok(Math.abs(near.seconds - 300 / speed) < 2e-4, `near arrival ${near.seconds}`);
  assert.ok(Math.abs(far.seconds - 600 / speed) < 2e-4, `far arrival ${far.seconds}`);
  assert.ok(Math.abs(near.value / far.value - 2) < .01, `ratio ${near.value / far.value}`);
});

test('a vertical channel arrives along t(z) = t_emit + sqrt(d² + z²)/c', () => {
  const emitter = { ...defaultLightning(), topMetres: { x: 0, y: 0, z: 3000 }, tortuosityDegrees: 0, strokeCount: 1 };
  const value = scene({ emitter, receivers: [receiverAt('mic', { x: 800, y: 0, z: 0 })] });
  const speed = speedOfSoundMetresPerSecond(value.air.temperatureCelsius);
  const result = render(value);
  for (const arrival of result.arrivals) {
    const emission = arrival.heightMetres / emitter.returnStrokeSpeedMetresPerSecond;
    const expected = emission + Math.hypot(800, arrival.heightMetres) / speed;
    assert.ok(Math.abs(arrival.seconds - expected) < 1e-9);
  }
  assert.ok(result.startSeconds <= 800 / speed && result.startSeconds + result.samples.length / result.sampleRate >= Math.hypot(800, 3000) / speed);
});

test('a long dense channel falls off as a line source, 1/sqrt(d)', () => {
  const emitter = { ...defaultLightning(), baseMetres: { x: 0, y: 0, z: 0 }, topMetres: { x: 0, y: 0, z: 8000 }, tortuosityDegrees: 0, strokeCount: 1 };
  const value = scene({ emitter, receivers: [receiverAt('near', { x: 100, y: 0, z: 4000 }), receiverAt('far', { x: 400, y: 0, z: 4000 })] });
  const ratio = Math.abs(peak(render(value, 0)).value / peak(render(value, 1)).value);
  assert.ok(Math.abs(ratio - 2) < .1, `ratio ${ratio}`);
});

test('identical scenes and seeds render identical samples; another seed differs', () => {
  const emitter = { ...defaultLightning(), topMetres: { x: 100, y: 0, z: 800 }, strokeCount: 1 };
  const value = scene({ emitter, receivers: [receiverAt('mic', { x: 1000, y: 0, z: 2 })] });
  const first = render(value).samples;
  assert.deepEqual(render(value).samples, first);
  const other = render(scene({ emitter: { ...emitter, seed: emitter.seed + 1 }, receivers: value.receivers })).samples;
  assert.notDeepEqual(other, first);
});

test('rigid ground adds an image arrival scaled by R1/R2', () => {
  const value = scene({ emitter: smallBlast({ x: 0, y: 0, z: 50 }), receivers: [receiverAt('mic', { x: 100, y: 0, z: 50 })], ground: { enabled: true, type: 'rigid' } });
  const speed = speedOfSoundMetresPerSecond(value.air.temperatureCelsius);
  const result = render(value);
  const imagePath = Math.hypot(100, 100);
  const direct = peak(result, 0, 100 / speed + .01);
  const reflected = peak(result, imagePath / speed - .002, imagePath / speed + .01);
  assert.ok(Math.abs(reflected.seconds - imagePath / speed) < 2e-4);
  assert.ok(Math.abs(reflected.value / direct.value - 100 / imagePath) < .01, `ratio ${reflected.value / direct.value}`);
});

test('ground reflection coefficient is one for rigid ground and below one for grass at normal incidence', () => {
  assert.deepEqual(sphericalReflectionCoefficient(1000, 'rigid', .2, 100, 343), [1, 0]);
  const [re, im] = sphericalReflectionCoefficient(1000, 'grass', 1, 100, 343);
  assert.ok(Math.hypot(re, im) < 1);
  for (const cosine of [0, .01, .1, .5, 1]) {
    for (const frequency of [1, 30, 300, 3000, 20000]) {
      for (const type of ['snow', 'grass', 'stonyGround']) {
        assert.ok(sphericalReflectionCoefficient(frequency, type, cosine, 2000, 343).every(Number.isFinite));
      }
    }
  }
});

test('air absorption lowers a distant peak without moving its arrival', () => {
  const receivers = [receiverAt('mic', { x: 3000, y: 0, z: 10 })];
  const dry = peak(render(scene({ emitter: smallBlast({ x: 0, y: 0, z: 10 }), receivers })));
  const absorbed = peak(render(scene({ emitter: smallBlast({ x: 0, y: 0, z: 10 }), receivers, absorption: true })));
  assert.ok(Math.abs(absorbed.value) < Math.abs(dry.value));
  assert.ok(Math.abs(absorbed.seconds - dry.seconds) < 1e-3);
});

test('renders are finite and refuse an arrival span over the limit', () => {
  const lightning = { ...defaultLightning(), topMetres: { x: 0, y: 0, z: 1500 }, strokeCount: 1 };
  const result = render(scene({ emitter: lightning, receivers: [receiverAt('mic', { x: 500, y: 0, z: 1.7 })], ground: { enabled: true, type: 'grass' }, absorption: true }));
  assert.ok(result.samples.every(Number.isFinite));
  assert.ok(result.peakPa > 0);
  const base = defaultScene();
  const wide = parseScene({
    ...base,
    emitters: [{ ...smallBlast({ x: 0, y: 0, z: 1 }), id: 'a' }, { ...smallBlast({ x: 48000, y: 0, z: 1 }), id: 'b' }],
    receivers: [receiverAt('mic', { x: 0, y: 0, z: 1 })]
  });
  assert.throws(() => render(wide), RangeError);
});
