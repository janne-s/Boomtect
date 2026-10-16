import {
  GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, KELVIN_OFFSET, STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED
} from './constants.js';

const REFERENCE_TEMPERATURE_KELVIN = 293.15;
const TRIPLE_POINT_TEMPERATURE_KELVIN = 273.16;
const REFERENCE_PRESSURE_KPA = 101.325;
const DECIBELS_PER_NEPER = 20 / Math.LN10;

/** Class A: c = sqrt(γ R T) for dry air as an ideal gas. */
export function speedOfSoundMetresPerSecond(temperatureCelsius) {
  return Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * (temperatureCelsius + KELVIN_OFFSET));
}

/** Class A: ideal-gas density ρ = p / (R T). */
export function airDensityKilogramsPerCubicMetre(pressurePa, temperatureCelsius) {
  return pressurePa / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * (temperatureCelsius + KELVIN_OFFSET));
}

/** Ground layer class C; troposphere and isothermal stratosphere ISO 2533, class B. */
export function temperatureLayers(air) {
  const ground = air.groundLayerMetres > 0 ? air.groundLayerMetres : 0;
  const tropopause = air.tropopauseMetres > ground ? air.tropopauseMetres : Infinity;
  const layers = [];
  if (ground > 0) layers.push({ base: 0, top: ground, lapse: air.groundLayerLapseKelvinPerMetre });
  layers.push({ base: ground, top: tropopause, lapse: air.lapseRateKelvinPerMetre });
  if (Number.isFinite(tropopause)) layers.push({ base: tropopause, top: Infinity, lapse: 0 });
  return layers;
}

export function temperatureAtHeightKelvin(air, heightMetres) {
  let kelvin = air.temperatureCelsius + KELVIN_OFFSET;
  for (const { base, top, lapse } of temperatureLayers(air)) {
    if (heightMetres <= base) break;
    kelvin -= lapse * (Math.min(heightMetres, top) - base);
  }
  return kelvin;
}

/** Class A for the profile; with Γ = 6.5 K/km and the tropopause at 11 km the ISA (ISO 2533, class B). */
export function pressureAtHeightPa(air, heightMetres) {
  const height = Math.max(0, heightMetres);
  let pressure = air.pressureKpa * 1000;
  let kelvin = air.temperatureCelsius + KELVIN_OFFSET;
  for (const { base, top, lapse } of temperatureLayers(air)) {
    if (height <= base) break;
    const span = Math.min(height, top) - base;
    const next = kelvin - lapse * span;
    if (Math.abs(lapse) * span < 1e-9 * kelvin) {
      pressure *= Math.exp(-STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED * span / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * kelvin));
    } else {
      pressure *= Math.max(0, next / kelvin) ** (STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * lapse));
    }
    kelvin = next;
  }
  return pressure;
}

/** ISO 9613-1. */
const saturationPressureRatio = temperatureKelvin => 10 ** (-6.8346 * (TRIPLE_POINT_TEMPERATURE_KELVIN / temperatureKelvin) ** 1.261 + 4.6151);

/** Vapour scale height class B (IRAM 30 m handbook; Armazones, arXiv 1103.3025); below the datum the ground air, class C. */
export function airAtHeight(air, heightMetres) {
  const height = Math.max(0, heightMetres);
  const groundKelvin = air.temperatureCelsius + KELVIN_OFFSET;
  const kelvin = temperatureAtHeightKelvin(air, height);
  const groundVapour = air.relativeHumidityPercent / 100 * saturationPressureRatio(groundKelvin);
  const vapour = groundVapour * Math.exp(-height / air.humidityScaleHeightMetres) * kelvin / groundKelvin;
  return {
    temperatureCelsius: kelvin - KELVIN_OFFSET,
    pressureKpa: pressureAtHeightPa(air, height) / 1000,
    relativeHumidityPercent: Math.min(100, 100 * vapour / saturationPressureRatio(kelvin))
  };
}

/** Class B: ISO 9613-1, pure tone. */
export function atmosphericAbsorptionDbPerMetre(frequencyHz, { temperatureCelsius, relativeHumidityPercent, pressureKpa }) {
  const temperatureKelvin = temperatureCelsius + KELVIN_OFFSET;
  const temperatureRatio = temperatureKelvin / REFERENCE_TEMPERATURE_KELVIN;
  const pressureRatio = pressureKpa / REFERENCE_PRESSURE_KPA;
  const waterVapourMolarPercent = relativeHumidityPercent * saturationPressureRatio(temperatureKelvin) / pressureRatio;
  const oxygenRelaxationHz = pressureRatio * (24 + 40400 * waterVapourMolarPercent * (.02 + waterVapourMolarPercent) / (.391 + waterVapourMolarPercent));
  const nitrogenRelaxationHz = pressureRatio * temperatureRatio ** -.5
    * (9 + 280 * waterVapourMolarPercent * Math.exp(-4.17 * (temperatureRatio ** (-1 / 3) - 1)));
  const classical = 1.84e-11 / pressureRatio * Math.sqrt(temperatureRatio);
  const molecular = temperatureRatio ** -2.5 * (
    .01275 * Math.exp(-2239.1 / temperatureKelvin) / (oxygenRelaxationHz + frequencyHz ** 2 / oxygenRelaxationHz)
    + .1068 * Math.exp(-3352 / temperatureKelvin) / (nitrogenRelaxationHz + frequencyHz ** 2 / nitrogenRelaxationHz)
  );
  return 8.686 * frequencyHz ** 2 * (classical + molecular);
}

export const atmosphericAbsorptionNepersPerMetre = (frequencyHz, atmosphere) =>
  atmosphericAbsorptionDbPerMetre(frequencyHz, atmosphere) / DECIBELS_PER_NEPER;
