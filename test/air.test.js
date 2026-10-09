import assert from 'node:assert/strict';
import test from 'node:test';
import {
  airDensityKilogramsPerCubicMetre, atmosphericAbsorptionDbPerMetre, pressureAtHeightPa, speedOfSoundMetresPerSecond
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
