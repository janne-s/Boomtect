import assert from 'node:assert/strict';
import test from 'node:test';
import { speedOfSoundMetresPerSecond } from '../src/domain/air.js';
import { sphericalReflectionCoefficient } from '../src/domain/ground.js';
import { combineSegments, partitionSeconds, prepareScene, renderReceiver, renderReceiverRange } from '../src/domain/render.js';
import { defaultBlast, defaultLightning, defaultReceiver, defaultScene, parseScene } from '../src/domain/scene.js';

function scene({ emitter, receivers, ground = { enabled: false, type: 'rigid' }, absorption = false, refraction = false }) {
  const base = defaultScene(emitter.kind === 'blast' ? 'blast' : 'thunder');
  return parseScene({ ...base, air: { ...base.air, absorption, refraction, turbulenceStrength: 0 }, ground, emitters: [emitter], receivers });
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

/** A ground flash with the same energy all along and no in-cloud channels, for geometric checks. */
const uniformChannel = () => ({ ...defaultLightning(), currentDecayHeightMetres: 1e6, inCloudLengthMetres: 0 });

const smallBlast = position => ({ ...defaultBlast(), chargeKilograms: .01, riseTimeSeconds: 1e-4, positionMetres: position });

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
  const emitter = { ...uniformChannel(), topMetres: { x: 0, y: 0, z: 3000 }, tortuosityDegrees: 0, macroTortuosityDegrees: 0, branchCount: 0, strokeCount: 1 };
  const value = scene({ emitter, receivers: [receiverAt('mic', { x: 800, y: 0, z: 0 })] });
  const speed = speedOfSoundMetresPerSecond(value.air.temperatureCelsius);
  const result = render(value);
  const { arrivals } = result;
  assert.equal(arrivals.count, 300);
  for (let index = 0; index < arrivals.count; index += 1) {
    const height = arrivals.heights[index];
    const expected = height / emitter.channelSpeedMetresPerSecond + Math.hypot(800, height) / speed;
    assert.ok(Math.abs(arrivals.seconds[index] - expected) < 1e-6);
  }
  assert.ok(result.startSeconds <= 800 / speed && result.startSeconds + result.samples.length / result.sampleRate >= Math.hypot(800, 3000) / speed);
});

test('with the weak shock off, a long dense channel falls off as a line source, 1/sqrt(d)', () => {
  const emitter = { ...uniformChannel(), baseMetres: { x: 0, y: 0, z: 0 }, topMetres: { x: 0, y: 0, z: 8000 }, tortuosityDegrees: 0, macroTortuosityDegrees: 0, branchCount: 0, energyVariation: 0, segmentLengthMetres: 2, straightLengthMetres: 2, weakShockLimitRadii: 10, riseTimeSeconds: 1e-4, strokeCount: 1 };
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
  const lightning = { ...defaultLightning(), topMetres: { x: 0, y: 0, z: 1500 }, strokeCount: 2 };
  const result = render(scene({ emitter: lightning, receivers: [receiverAt('mic', { x: 500, y: 0, z: 1.7 })], ground: { enabled: true, type: 'grass' }, absorption: true }));
  assert.ok(result.samples.every(Number.isFinite));
  assert.ok(result.peakPa > 0);
  const base = defaultScene('blast');
  const wide = parseScene({
    ...base,
    emitters: [{ ...smallBlast({ x: 0, y: 0, z: 1 }), id: 'a' }, { ...smallBlast({ x: 48000, y: 0, z: 1 }), id: 'b', startSeconds: 100 }],
    receivers: [receiverAt('mic', { x: 0, y: 0, z: 1 })]
  });
  assert.throws(() => render(wide), RangeError);
});

test('an onset delays every arrival by exactly that time', () => {
  const receivers = [receiverAt('mic', { x: 400, y: 0, z: 10 })];
  const now = peak(render(scene({ emitter: smallBlast({ x: 0, y: 0, z: 10 }), receivers })));
  const later = peak(render(scene({ emitter: { ...smallBlast({ x: 0, y: 0, z: 10 }), startSeconds: 1.5 }, receivers })));
  assert.ok(Math.abs(later.seconds - now.seconds - 1.5) < 1 / 48000);
  assert.ok(Math.abs(later.value / now.value - 1) < 1e-3);
});

test('a render split by arrival time sums to the single-thread render', () => {
  const lightning = { ...defaultLightning(), topMetres: { x: 200, y: 0, z: 1200 }, branchDepth: 1, strokeCount: 2 };
  const value = scene({ emitter: lightning, receivers: [receiverAt('mic', { x: 700, y: 100, z: 2 })], ground: { enabled: true, type: 'grass' }, absorption: true });
  const prepared = prepareScene(value);
  const whole = render(value);
  const boundaries = partitionSeconds(prepared, value, 3);
  const parts = boundaries.slice(0, -1).map((from, index) => renderReceiverRange(prepared, value.receivers[0], value, { fromSeconds: from, toSeconds: boundaries[index + 1] }));
  const split = combineSegments(parts, value.render.sampleRate);
  split.samples = split.channels[0];
  assert.equal(split.startSeconds, whole.startSeconds);
  assert.equal(split.samples.length, whole.samples.length);
  let largest = 0;
  split.samples.forEach((sample, index) => { largest = Math.max(largest, Math.abs(sample - whole.samples[index])); });
  assert.ok(largest < whole.peakPa * 1e-6, `difference ${largest}`);
});

test('turbulence leaves low frequencies coherent and decorrelates high ones', async () => {
  const { turbulentPhaseVariance } = await import('../src/domain/render.js');
  const air = { turbulenceStrength: 1e-6, turbulenceScaleMetres: 1.1 };
  const low = turbulentPhaseVariance(100, 1000, 1, 1.7, air, 340);
  const high = turbulentPhaseVariance(4000, 1000, 1, 1.7, air, 340);
  assert.ok(low < .01 && high > 1, `${low} ${high}`);
  assert.equal(turbulentPhaseVariance(1000, 1000, 1, 1.7, { ...air, turbulenceStrength: 0 }, 340), 0);
});

test('turbulence fills the grazing ground dip of a distant blast', () => {
  const receivers = [receiverAt('mic', { x: 1000, y: 0, z: 1.7 })];
  // A small charge, whose pulse has aged past being a shock by 1 km, so the ground reflects it linearly.
  const base = { emitter: smallBlast({ x: 0, y: 0, z: 1 }), receivers, ground: { enabled: true, type: 'grass' } };
  const calm = render(scene(base));
  const turbulentScene = scene(base);
  turbulentScene.air.turbulenceStrength = 1e-6;
  const windy = render(turbulentScene);
  const energy = samples => samples.reduce((sum, value) => sum + value * value, 0);
  assert.ok(energy(windy.samples) > energy(calm.samples));
});

test('the omnidirectional channel is the pressure and a source in the east sounds from the east', () => {
  const value = scene({ emitter: smallBlast({ x: 500, y: 0, z: 10 }), receivers: [receiverAt('mic', { x: 0, y: 0, z: 10 })] });
  value.render.ambisonicOrder = 1;
  const result = render(value);
  const index = result.samples.reduce((best, sample, at, all) => (Math.abs(sample) > Math.abs(all[best]) ? at : best), 0);
  const [w, y, z, x] = result.channels.map(channel => channel[index]);
  assert.equal(result.channels.length, 4);
  assert.ok(Math.abs(y / w + 1) < 1e-6, `east is to the right of north: ${y / w}`);
  assert.ok(Math.abs(x / w) < 1e-6 && Math.abs(z / w) < 1e-6);
});

test('with refraction a lit blast arrives at the ray travel time and keeps its free-field level within 1 dB', async () => {
  const { rayBetween, soundSpeedProfile } = await import('../src/domain/refraction.js');
  const source = { x: 0, y: 0, z: 1000 };
  const mic = { x: 5000, y: 0, z: 1.7 };
  const bent = scene({ emitter: smallBlast(source), receivers: [receiverAt('mic', mic)], refraction: true });
  const straight = scene({ emitter: smallBlast(source), receivers: [receiverAt('mic', mic)] });
  const ray = rayBetween(soundSpeedProfile(bent.air), source, mic);
  const refracted = peak(render(bent));
  const free = peak(render(straight));
  const straightSeconds = Math.hypot(5000, 998.3) / speedOfSoundMetresPerSecond(straight.air.temperatureCelsius);
  // Both peaks sit the same rise time after their arrivals, so their difference is the travel-time difference.
  assert.ok(Math.abs(refracted.seconds - free.seconds - (ray.seconds - straightSeconds)) < 1.5 / 48000);
  assert.ok(refracted.seconds > free.seconds);
  assert.ok(Math.abs(20 * Math.log10(Math.abs(refracted.value / free.value))) < 1);
});

test('a blast beyond the shadow boundary is 15–27 dB below its free-field level and arrives later', () => {
  const source = { x: 0, y: 0, z: 2000 };
  const mic = { x: 25000, y: 0, z: 1.7 };
  const shadowed = peak(render(scene({ emitter: smallBlast(source), receivers: [receiverAt('mic', mic)], refraction: true })));
  const free = peak(render(scene({ emitter: smallBlast(source), receivers: [receiverAt('mic', mic)] })));
  const drop = 20 * Math.log10(Math.abs(free.value / shadowed.value));
  assert.ok(drop > 15 && drop < 27, `${drop} dB`);
  assert.ok(shadowed.seconds > free.seconds);
});

test('an inversion brings a ground reflection to a distant microphone that refraction off also has', () => {
  const source = { x: 0, y: 0, z: 5 };
  const receivers = [receiverAt('mic', { x: 8000, y: 0, z: 1.7 })];
  const ground = { enabled: true, type: 'rigid' };
  const inverted = scene({ emitter: smallBlast(source), receivers, ground, refraction: true });
  inverted.air.lapseRateKelvinPerMetre = -.01;
  const paths = render(inverted).arrivals;
  // The direct ray first, then the reflection and the rays the inversion bends back to touch the ground again.
  assert.ok(paths.count > 2);
  assert.equal(paths.kinds[0], 0);
  assert.ok([...paths.kinds].slice(1).every(kind => kind === 1));
  assert.ok(render(inverted).samples.every(Number.isFinite));
});

test('the shadow response is causal, lossless at low frequencies, f^(1/3) creeping above, and ends in its frame tail', async () => {
  const { shadowResponse, shadowTailSeconds } = await import('../src/domain/render.js');
  const { creepingCoefficient, soundSpeedProfile } = await import('../src/domain/refraction.js');
  const { fft } = await import('../src/domain/fft.js');
  const coefficient = creepingCoefficient(soundSpeedProfile({ temperatureCelsius: 15, lapseRateKelvinPerMetre: .0065, refraction: true }));
  const floor = 10 ** (-25 / 20);
  for (const creep of [1000, 8000, 30000]) {
    const nepers = coefficient * creep;
    assert.ok(Math.abs(Math.hypot(...shadowResponse(.01, nepers, 0)) - 1) < 1e-3);
    for (const frequency of [100, 400, 2000]) {
      const loss = -Math.log(Math.hypot(...shadowResponse(frequency, nepers, 0)));
      const creeping = nepers * Math.cbrt(frequency);
      assert.ok(Math.abs(loss / creeping - 1) < .05, `${creep} m, ${frequency} Hz: ${loss} vs ${creeping} Np`);
    }
    assert.ok(Math.abs(Math.hypot(...shadowResponse(20000, nepers * 50, floor)) / floor - 1) < 1e-3);
    // Impulse response, band-limited to 4 kHz: nothing before the arrival, and at most −80 dB after the tail.
    const size = 1 << 17;
    const rate = 48000;
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let bin = 1; bin < size / 2; bin += 1) {
      const frequency = bin * rate / size;
      const [a, b] = shadowResponse(frequency, nepers, 0);
      const limit = Math.exp(-((frequency / 4000) ** 2));
      re[bin] = a * limit; im[bin] = b * limit; re[size - bin] = re[bin]; im[size - bin] = -im[bin];
    }
    re[0] = 1;
    fft(re, im, true);
    const largest = values => values.reduce((most, value) => Math.max(most, Math.abs(value)), 0);
    const peak = largest(re);
    const tail = Math.ceil(shadowTailSeconds(nepers) * rate);
    const after = largest(re.slice(tail, size / 2));
    // The test's own zero-phase band limit spreads the arrival by a fraction of a millisecond.
    const before = largest(re.slice(size - rate / 10, size - rate / 1000));
    assert.ok(after < peak * 1e-4, `${creep} m: tail ${20 * Math.log10(after / peak)} dB`);
    assert.ok(before < peak * 1e-5, `${creep} m: before arrival ${20 * Math.log10(before / peak)} dB`);
  }
});

test('a strong blast keeps its shock: grazing over grass it merges with its reflection as over rigid ground, and absorption does not round its front', () => {
  const at = (ground, absorption = true, charge = 10) => {
    const value = scene({ emitter: { ...defaultBlast(), chargeKilograms: charge, positionMetres: { x: 0, y: 0, z: 1 } }, receivers: [receiverAt('mic', { x: 400, y: 0, z: 1.7 })], ground });
    value.air.absorption = absorption;
    value.air.turbulenceStrength = 0;
    return render(value).samples;
  };
  const energy = samples => samples.reduce((sum, value) => sum + value * value, 0);
  const grass = at({ enabled: true, type: 'grass' });
  const rigid = at({ enabled: true, type: 'rigid' });
  assert.ok(Math.abs(10 * Math.log10(energy(grass) / energy(rigid))) < .1);
  // The 10–90 % rise of the front, with and without absorption.
  const rise = samples => {
    let peak = 0;
    let top = 0;
    samples.forEach((value, index) => { if (value > peak) { peak = value; top = index; } });
    let low = top;
    let high = top;
    while (low > 0 && samples[low] > .1 * peak) low -= 1;
    while (high > 0 && samples[high] > .9 * peak) high -= 1;
    return (high - low) / 48000;
  };
  const free = { enabled: false, type: 'grass' };
  assert.ok(rise(at(free)) < 1e-4, `${rise(at(free))} s`);
  assert.ok(Math.abs(rise(at(free)) - rise(at(free, false))) < 5e-5);
  // A small charge has aged past a shock by 400 m: grass still reflects it linearly.
  assert.ok(Math.abs(10 * Math.log10(energy(at({ enabled: true, type: 'grass' }, true, .001)) / energy(at({ enabled: true, type: 'rigid' }, true, .001)))) > 1);
});
