import {
  GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, ISA_LAPSE_RATE_KELVIN_PER_METRE, ISA_PRESSURE_EXPONENT, KELVIN_OFFSET
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

/** Class B: ISA troposphere pressure at a height, anchored to the ground temperature and pressure. */
export function pressureAtHeightPa(groundPressurePa, groundTemperatureCelsius, heightMetres) {
  const groundKelvin = groundTemperatureCelsius + KELVIN_OFFSET;
  const ratio = 1 - ISA_LAPSE_RATE_KELVIN_PER_METRE * Math.max(0, heightMetres) / groundKelvin;
  return groundPressurePa * Math.max(0, ratio) ** ISA_PRESSURE_EXPONENT;
}

/**
 * Class B: ISO 9613-1 pure-tone atmospheric attenuation coefficient in dB/m.
 * Adopted from Echotect `src/acoustics.js` at commit cb712ef6.
 */
export function atmosphericAbsorptionDbPerMetre(frequencyHz, { temperatureCelsius, relativeHumidityPercent, pressureKpa }) {
  const temperatureKelvin = temperatureCelsius + KELVIN_OFFSET;
  const temperatureRatio = temperatureKelvin / REFERENCE_TEMPERATURE_KELVIN;
  const pressureRatio = pressureKpa / REFERENCE_PRESSURE_KPA;
  const saturationPressureRatio = 10 ** (-6.8346 * (TRIPLE_POINT_TEMPERATURE_KELVIN / temperatureKelvin) ** 1.261 + 4.6151);
  const waterVapourMolarPercent = relativeHumidityPercent * saturationPressureRatio / pressureRatio;
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
