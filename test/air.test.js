import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultScene } from '../src/domain/scene.js';
import {
  airAtHeight, airDensityKilogramsPerCubicMetre, atmosphericAbsorptionDbPerMetre, pressureAtHeightPa, speedOfSoundMetresPerSecond
} from '../src/domain/air.js';

test('speed of sound follows sqrt(γRT)', () => {
  assert.ok(Math.abs(speedOfSoundMetresPerSecond(20) - 343.23) < .01);
  assert.ok(Math.abs(speedOfSoundMetresPerSecond(0) - 331.32) < .01);
});

test('343 metres take one second at 343 m/s', () => {
  assert.equal(343 / 343, 1);
  const temperature = 343 ** 2 / (1.4 * 287.05) - 273.15;
  assert.ok(Math.abs(343 / speedOfSoundMetresPerSecond(temperature) - 1) < 1e-12);
});

test('air density at sea level and 15 °C is about 1.225 kg/m³', () => {
  assert.ok(Math.abs(airDensityKilogramsPerCubicMetre(101325, 15) - 1.225) < .001);
});

test('pressure follows the ISA table and the isothermal limit', () => {
  const isa = { temperatureCelsius: 15, pressureKpa: 101.325, lapseRateKelvinPerMetre: .0065 };
  assert.equal(pressureAtHeightPa(isa, 0), 101325);
  // ISO 2533: 54 020 Pa at 5 km and 26 436 Pa at 10 km.
  assert.ok(Math.abs(pressureAtHeightPa(isa, 5000) / 54020 - 1) < 1e-3);
  assert.ok(Math.abs(pressureAtHeightPa(isa, 10000) / 26436 - 1) < 1e-3);
  const isothermal = { ...isa, lapseRateKelvinPerMetre: 0 };
  assert.ok(Math.abs(pressureAtHeightPa(isothermal, 8000) / (101325 * Math.exp(-9.80665 * 8000 / (287.05 * 288.15))) - 1) < 1e-12);
  assert.ok(Math.abs(pressureAtHeightPa({ ...isa, lapseRateKelvinPerMetre: 1e-7 }, 8000) / pressureAtHeightPa(isothermal, 8000) - 1) < 1e-4);
  assert.ok(pressureAtHeightPa({ ...isa, lapseRateKelvinPerMetre: -.01 }, 2000) > pressureAtHeightPa(isa, 2000));
});

test('ISO 9613-1 absorption matches the 20 °C, 70 % table within 2 %', () => {
  const air = { temperatureCelsius: 20, relativeHumidityPercent: 70, pressureKpa: 101.325 };
  const table = { 1000: 5.0, 2000: 9.0, 4000: 22.9, 8000: 76.6 };
  for (const [frequency, dbPerKm] of Object.entries(table)) {
    const computed = atmosphericAbsorptionDbPerMetre(Number(frequency), air) * 1000;
    assert.ok(Math.abs(computed / dbPerKm - 1) < .02, `${frequency} Hz: ${computed}`);
  }
});

test('layered air starts from the ground air, loses its vapour with height, and never exceeds saturation', () => {
  const air = { temperatureCelsius: 15, relativeHumidityPercent: 70, pressureKpa: 101.325, lapseRateKelvinPerMetre: .0065, humidityScaleHeightMetres: 2000 };
  const ground = airAtHeight(air, 0);
  assert.ok(Math.abs(ground.temperatureCelsius - 15) < 1e-12 && Math.abs(ground.pressureKpa - 101.325) < 1e-9 && Math.abs(ground.relativeHumidityPercent - 70) < 1e-9);
  // At 2 km the vapour pressure is e₀·e⁻¹·T/T₀ and the air 13 K colder.
  const high = airAtHeight(air, 2000);
  const saturation = kelvin => 10 ** (-6.8346 * (273.16 / kelvin) ** 1.261 + 4.6151);
  const expected = 70 * saturation(288.15) * Math.exp(-1) * 275.15 / 288.15 / saturation(275.15);
  assert.ok(Math.abs(high.relativeHumidityPercent - expected) < 1e-9, `${high.relativeHumidityPercent}`);
  for (let height = 0; height <= 15000; height += 500) assert.ok(airAtHeight({ ...air, relativeHumidityPercent: 100, humidityScaleHeightMetres: 10000 }, height).relativeHumidityPercent <= 100);
});

test('near the ground, layered absorption renders a blast within 0.05 dB of the ground air', () => {
  const energy = air => {
    const scene = defaultScene('blast');
    scene.air = { ...scene.air, ...air, lapseRateKelvinPerMetre: 0 };
    scene.receivers[0].positionMetres = { x: 2000, y: 0, z: 1.7 };
    const { samples } = renderReceiver(prepareScene(scene), scene.receivers[0], scene);
    return samples.reduce((sum, value) => sum + value * value, 0);
  };
  const layered = energy({ refraction: true });
  const ground = energy({ refraction: false });
  assert.ok(Math.abs(10 * Math.log10(layered / ground)) < .05, `${10 * Math.log10(layered / ground)} dB`);
});

test('above the tropopause the standard atmosphere keeps 216.65 K and its pressure falls exponentially', async () => {
  const { temperatureAtHeightKelvin } = await import('../src/domain/air.js');
  const isa = { temperatureCelsius: 15, pressureKpa: 101.325, lapseRateKelvinPerMetre: .0065, tropopauseMetres: 11000 };
  assert.ok(Math.abs(temperatureAtHeightKelvin(isa, 12000) - 216.65) < 1e-9);
  // ISO 2533: 22 632 Pa at 11 km and 12 045 Pa at 15 km.
  assert.ok(Math.abs(pressureAtHeightPa(isa, 11000) / 22632 - 1) < 1e-3);
  assert.ok(Math.abs(pressureAtHeightPa(isa, 15000) / 12045 - 1) < 1e-3);
  // A ground layer of its own lapse rate: a 200 m inversion of 20 K/km is 4 K warmer at its top.
  const inversion = { ...isa, groundLayerMetres: 200, groundLayerLapseKelvinPerMetre: -.02 };
  assert.ok(Math.abs(temperatureAtHeightKelvin(inversion, 200) - 292.15) < 1e-9);
  assert.ok(Math.abs(temperatureAtHeightKelvin(inversion, 1200) - (292.15 - 6.5)) < 1e-9);
});
