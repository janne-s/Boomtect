import assert from 'node:assert/strict';
import test from 'node:test';
import {
  creepingCoefficient, firstArrival, grazingRange, inShadow, rayBetween, reflectedRay, shadowPath, soundSpeedProfile, speedAt, travelSeconds, wavefront
} from '../src/domain/refraction.js';

const air = (overrides = {}) => ({
  temperatureCelsius: 15, relativeHumidityPercent: 70, pressureKpa: 101.325, lapseRateKelvinPerMetre: .0065, refraction: true, ...overrides
});
const isa = soundSpeedProfile(air());
const inversion = soundSpeedProfile(air({ lapseRateKelvinPerMetre: -.01 }));

/**
 * Reference ray by numerical integration (RK4 in arc length) of dx/ds = cos θ, dz/ds = sin θ,
 * dθ/ds = −g·cos θ / c, dt/ds = 1/c, launched at elevation θ₀ in the vertical plane, reflecting at
 * the ground, until it has covered `horizontal` metres. Returns height, time, arrival elevation, the
 * lowest height reached, and the arc length.
 */
function shoot(profile, z0, theta0, horizontal, { reflect = false, step = .5 } = {}) {
  let state = [0, z0, theta0, 0];
  let s = 0;
  let lowest = z0;
  let bounces = 0;
  const derivative = ([, z, theta]) => {
    const c = speedAt(profile, z);
    return [Math.cos(theta), Math.sin(theta), -profile.gradient * Math.cos(theta) / c, 1 / c];
  };
  const advance = (current, h) => {
    const k1 = derivative(current);
    const k2 = derivative(current.map((v, i) => v + h / 2 * k1[i]));
    const k3 = derivative(current.map((v, i) => v + h / 2 * k2[i]));
    const k4 = derivative(current.map((v, i) => v + h * k3[i]));
    return current.map((v, i) => v + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  };
  while (state[0] < horizontal) {
    let h = Math.min(step, (horizontal - state[0]) / Math.max(1e-9, Math.cos(state[2])));
    let next = advance(state, h);
    if (reflect && next[1] < 0 && bounces === 0) {
      // Bisect the step to the ground, then mirror the elevation.
      let low = 0;
      let high = h;
      for (let i = 0; i < 60; i += 1) { const mid = (low + high) / 2; if (advance(state, mid)[1] < 0) high = mid; else low = mid; }
      state = advance(state, low);
      state[1] = 0;
      state[2] = -state[2];
      s += low;
      bounces += 1;
      continue;
    }
    if (h < 1e-12) break;
    state = next;
    s += h;
    lowest = Math.min(lowest, state[1]);
  }
  return { z: state[1], seconds: state[3], elevation: state[2], lowest, metres: s, bounces };
}

const elevation = direction => Math.atan2(direction.z, Math.hypot(direction.x, direction.y));

test('homogeneous air gives straight rays: D/c, spreading D, and the image path', () => {
  const profile = soundSpeedProfile(air({ refraction: false }));
  const a = { x: 0, y: 0, z: 300 };
  const b = { x: 3000, y: 4000, z: 2 };
  const ray = rayBetween(profile, a, b);
  const distance = Math.hypot(3000, 4000, 298);
  assert.ok(Math.abs(ray.seconds - distance / profile.groundSpeed) < 1e-12);
  assert.ok(Math.abs(ray.spreadMetres - distance) < 1e-9);
  assert.ok(Math.abs(ray.metres - distance) < 1e-9);
  assert.ok(Math.abs(ray.departure.x - 3000 / distance) < 1e-12 && Math.abs(ray.arrival.z + 298 / distance) < 1e-12);
  const reflected = reflectedRay(profile, a, b);
  const image = Math.hypot(3000, 4000, 302);
  assert.ok(Math.abs(reflected.seconds - image / profile.groundSpeed) < 1e-9);
  assert.ok(Math.abs(reflected.spreadMetres - image) < 1e-6 * image);
  assert.ok(Math.abs(reflected.groundSine - 302 / image) < 1e-9);
  assert.equal(inShadow(profile, a, b), false);
});

test('a vanishing gradient approaches the homogeneous result', () => {
  const nearlyFlat = soundSpeedProfile(air({ lapseRateKelvinPerMetre: 1e-9 }));
  const flat = soundSpeedProfile(air({ refraction: false }));
  const a = { x: 0, y: 0, z: 4000 };
  const b = { x: 9000, y: 0, z: 1.7 };
  const bent = rayBetween(nearlyFlat, a, b);
  const straight = rayBetween(flat, a, b);
  assert.ok(Math.abs(bent.seconds - straight.seconds) < 1e-6);
  assert.ok(Math.abs(bent.spreadMetres / straight.spreadMetres - 1) < 1e-6);
});

test('direct rays match numerical integration: height ±1 mm, time ±1 µs, angle ±1 µrad', () => {
  const cases = [
    [isa, { x: 0, y: 0, z: 4000 }, { x: 12000, y: 5000, z: 1.7 }],
    [isa, { x: 0, y: 0, z: 30 }, { x: 900, y: 0, z: 1.7 }],
    [isa, { x: 0, y: 0, z: 1.7 }, { x: 0, y: 8000, z: 6000 }],
    [inversion, { x: 0, y: 0, z: 100 }, { x: 15000, y: 0, z: 2 }],
    [inversion, { x: 0, y: 0, z: 8000 }, { x: -3000, y: 2000, z: 10 }]
  ];
  for (const [profile, a, b] of cases) {
    const ray = rayBetween(profile, a, b);
    const horizontal = Math.hypot(b.x - a.x, b.y - a.y);
    const reference = shoot(profile, a.z, elevation(ray.departure), horizontal);
    assert.ok(Math.abs(reference.z - b.z) < 1e-3, `height ${reference.z} vs ${b.z}`);
    assert.ok(Math.abs(reference.seconds - ray.seconds) < 1e-6, `time ${reference.seconds} vs ${ray.seconds}`);
    assert.ok(Math.abs(reference.elevation - elevation(ray.arrival)) < 1e-6);
    assert.ok(Math.abs(reference.metres - ray.metres) < 1e-3 * Math.max(1, ray.metres / 1000));
  }
});

test('travel time is reciprocal and Snell’s invariant cos θ / c holds along a ray', () => {
  const a = { x: 0, y: 0, z: 5200 };
  const b = { x: 7000, y: -2000, z: 3 };
  const there = rayBetween(isa, a, b);
  const back = rayBetween(isa, b, a);
  assert.ok(Math.abs(there.seconds - back.seconds) < 1e-12);
  const invariant = direction => Math.hypot(direction.x, direction.y);
  assert.ok(Math.abs(invariant(there.departure) / speedAt(isa, a.z) - invariant(there.arrival) / speedAt(isa, b.z)) < 1e-12);
});

/**
 * Ray-tube spreading by finite differences of the launch angle over the horizontal distance:
 * A = ρ·|∂ρ/∂θ₀|·|sin θr| / cos θ₀, for receivers on one height.
 */
function tubeSpread(pathOf, source, receiverHeight, horizontal) {
  const delta = horizontal * 1e-5;
  const near = pathOf(source, { x: horizontal - delta, y: 0, z: receiverHeight });
  const far = pathOf(source, { x: horizontal + delta, y: 0, z: receiverHeight });
  const middle = pathOf(source, { x: horizontal, y: 0, z: receiverHeight });
  const launch = Math.abs(elevation(far.departure) - elevation(near.departure)) / (2 * delta);
  return Math.sqrt(horizontal / launch * Math.abs(Math.sin(elevation(middle.arrival))) / Math.cos(elevation(middle.departure)));
}

test('spreading equals the ray tube of neighbouring rays within 0.1 %', () => {
  for (const [profile, zs, zr, horizontal] of [[isa, 4000, 1.7, 15000], [isa, 300, 50, 3000], [inversion, 200, 2, 8000], [inversion, 6000, 2, 4000]]) {
    const source = { x: 0, y: 0, z: zs };
    const direct = rayBetween(profile, source, { x: horizontal, y: 0, z: zr });
    const expected = tubeSpread((a, b) => rayBetween(profile, a, b), source, zr, horizontal);
    assert.ok(Math.abs(direct.spreadMetres / expected - 1) < 1e-3, `direct ${direct.spreadMetres} vs ${expected}`);
    const reflected = reflectedRay(profile, source, { x: horizontal, y: 0, z: zr });
    const expectedReflected = tubeSpread((a, b) => reflectedRay(profile, a, b), source, zr, horizontal);
    assert.ok(Math.abs(reflected.spreadMetres / expectedReflected - 1) < 1e-3, `reflected ${reflected.spreadMetres} vs ${expectedReflected}`);
  }
});

test('reflected rays match numerical integration with one bounce, also after turning in an inversion', () => {
  const cases = [
    [isa, 4000, 1.7, 15000],
    [isa, 2, 1.7, 400],
    [inversion, 2, 1.7, 3000],
    [inversion, 100, 2, 30000]
  ];
  for (const [profile, zs, zr, horizontal] of cases) {
    const ray = reflectedRay(profile, { x: 0, y: 0, z: zs }, { x: horizontal, y: 0, z: zr });
    assert.ok(ray, `no reflection for ${zs} m → ${horizontal} m`);
    const reference = shoot(profile, zs, elevation(ray.departure), horizontal, { reflect: true, step: .25 });
    assert.equal(reference.bounces, 1);
    assert.ok(Math.abs(reference.z - zr) < 1e-2, `height ${reference.z} vs ${zr}`);
    assert.ok(Math.abs(reference.seconds - ray.seconds) < 1e-5, `time ${reference.seconds} vs ${ray.seconds}`);
    assert.ok(Math.abs(reference.elevation - elevation(ray.arrival)) < 1e-5);
  }
});

test('the shadow starts where the limiting ray grazes the ground, as in Fleagle (1949)', () => {
  // Fleagle's example: T₀ = 30 °C, Γ = 9.8 K/km, a source 5 km up is heard to about 25 km. The
  // exact sqrt(T) profile gives the grazing ray x = ∫ c / sqrt(c₀² − c²) dz.
  const profile = soundSpeedProfile(air({ temperatureCelsius: 30, lapseRateKelvinPerMetre: .0098 }));
  const range = grazingRange(profile, 5000) + grazingRange(profile, 0);
  const speed = z => Math.sqrt(1.4 * 287.05 * (303.15 - .0098 * z));
  let exact = 0;
  for (let index = 0; index < 100000; index += 1) {
    const z = (index + .5) / 100000 * 5000;
    exact += speed(z) / Math.sqrt(speed(0) ** 2 - speed(z) ** 2) * .05;
  }
  assert.ok(Math.abs(range / exact - 1) < .015, `${range} m vs ${exact} m`);
  assert.ok(Math.abs(range - 25000) < 1500, `${range} m`);
  // Below small heights it is sqrt(2·c₀·z/|g|).
  const small = grazingRange(isa, 1.7);
  assert.ok(Math.abs(small / Math.sqrt(2 * isa.groundSpeed * 1.7 / -isa.gradient) - 1) < 1e-4);
  // Just inside, the direct ray stays above the ground; just outside, it would pass below.
  const source = { x: 0, y: 0, z: 4000 };
  const boundary = grazingRange(isa, 4000) + grazingRange(isa, 1.7);
  for (const [factor, lit] of [[.999, true], [1.001, false]]) {
    const receiver = { x: boundary * factor, y: 0, z: 1.7 };
    const ray = rayBetween(isa, source, receiver);
    const reference = shoot(isa, 4000, elevation(ray.departure), receiver.x, { step: 2 });
    assert.equal(reference.lowest >= -1e-3, lit);
    assert.equal(inShadow(isa, source, receiver), !lit);
    assert.equal(reflectedRay(isa, source, receiver) !== null, lit);
  }
});

test('the shadow path joins the direct ray at the boundary and creeps along the ground beyond it', () => {
  const source = { x: 0, y: 0, z: 3000 };
  const boundary = grazingRange(isa, 3000) + grazingRange(isa, 1.7);
  const lit = rayBetween(isa, source, { x: boundary * (1 - 1e-7), y: 0, z: 1.7 });
  const shadow = shadowPath(isa, source, { x: boundary * (1 + 1e-7), y: 0, z: 1.7 });
  assert.ok(Math.abs(lit.seconds - shadow.seconds) < 1e-3);
  assert.ok(Math.abs(lit.spreadMetres / shadow.spreadMetres - 1) < 1e-3);
  const farther = shadowPath(isa, source, { x: boundary + 2000, y: 0, z: 1.7 });
  assert.ok(Math.abs(farther.creepMetres - 2000) < 1e-6);
  assert.ok(Math.abs(farther.seconds - shadow.seconds - 2000 / isa.groundSpeed) < 1e-3);
  assert.equal(firstArrival(isa, source, { x: boundary + 2000, y: 0, z: 1.7 }).seconds, farther.seconds);
  assert.equal(firstArrival(isa, source, { x: boundary - 2000, y: 0, z: 1.7 }).creepMetres, undefined);
  // Creeping attenuation grows as f^(1/3) and with the gradient; none without a shadow.
  assert.ok(creepingCoefficient(isa) > 0);
  assert.equal(creepingCoefficient(inversion), 0);
  assert.ok(creepingCoefficient(soundSpeedProfile(air({ lapseRateKelvinPerMetre: .0098 }))) > creepingCoefficient(isa));
});

test('a point source’s wavefront is a sphere whose points all lie one travel time away', () => {
  for (const profile of [isa, inversion]) {
    const source = { x: 100, y: -50, z: 2500 };
    const { centre, radiusMetres } = wavefront(profile, source, 9);
    for (let index = 0; index < 12; index += 1) {
      const polar = Math.acos(1 - 2 * (index + .5) / 12);
      const azimuth = index * 2.39996;
      const point = {
        x: centre.x + radiusMetres * Math.sin(polar) * Math.cos(azimuth),
        y: centre.y + radiusMetres * Math.sin(polar) * Math.sin(azimuth),
        z: centre.z + radiusMetres * Math.cos(polar)
      };
      assert.ok(Math.abs(rayBetween(profile, source, point).seconds - 9) < 1e-9);
    }
  }
});

test('the ISA profile is exact at the ground and within 1.8 m/s of sqrt(γRT) up to 10 km', () => {
  const profile = soundSpeedProfile(air());
  const exact = z => Math.sqrt(1.4 * 287.05 * (288.15 - .0065 * z));
  assert.ok(Math.abs(speedAt(profile, 0) - exact(0)) < 1e-9);
  for (let z = 0; z <= 10000; z += 250) assert.ok(Math.abs(speedAt(profile, z) - exact(z)) < 1.8);
  assert.equal(soundSpeedProfile(air({ refraction: false })).gradient, 0);
});

test('the view\u2019s travel time equals the first arrival\u2019s, lit and in the shadow', () => {
  const source = { x: 0, y: 0, z: 2500 };
  for (const x of [3000, 15000, 30000]) {
    const receiver = { x, y: 400, z: 1.7 };
    assert.ok(Math.abs(travelSeconds(isa, source, receiver) - firstArrival(isa, source, receiver).seconds) < 1e-9);
  }
});
