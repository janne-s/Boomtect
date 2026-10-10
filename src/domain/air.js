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

/** Temperature at a height for the scene's linear profile T(z) = T₀ − Γz, in kelvin. */
export function temperatureAtHeightKelvin(air, heightMetres) {
  return air.temperatureCelsius + KELVIN_OFFSET - air.lapseRateKelvinPerMetre * heightMetres;
}

/**
 * Class A for the given profile: hydrostatic pressure of an ideal gas with T(z) = T₀ − Γz,
 * p = p₀·(T/T₀)^(g/(RΓ)), and p₀·exp(−gz/(RT₀)) without a gradient. With Γ = 6.5 K/km it is the
 * ISA troposphere (ISO 2533, class B as a model of the real atmosphere).
 */
export function pressureAtHeightPa(air, heightMetres) {
  const groundPa = air.pressureKpa * 1000;
  const groundKelvin = air.temperatureCelsius + KELVIN_OFFSET;
  const height = Math.max(0, heightMetres);
  const lapse = air.lapseRateKelvinPerMetre;
  if (Math.abs(lapse) * height < 1e-9 * groundKelvin) {
    return groundPa * Math.exp(-STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED * height / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * groundKelvin));
  }
  const ratio = Math.max(0, temperatureAtHeightKelvin(air, height) / groundKelvin);
  return groundPa * ratio ** (STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * lapse));
}

/** ISO 9613-1: saturation vapour pressure over the reference pressure, at a temperature in kelvin. */
const saturationPressureRatio = temperatureKelvin => 10 ** (-6.8346 * (TRIPLE_POINT_TEMPERATURE_KELVIN / temperatureKelvin) ** 1.261 + 4.6151);

/**
 * The air at a height above the datum for the scene's layered atmosphere: temperature and pressure
 * from the linear profile, and humidity from water vapour whose density falls as exp(−z/H) with the
 * scale height H (class B: typically about 2 km, IRAM 30 m handbook; a median of 1.7 ± 0.5 km at
 * Armazones, arXiv 1103.3025), its relative humidity capped at saturation. Below the datum the
 * ground air is used (class C).
 */
export function airAtHeight(air, heightMetres) {
  const height = Math.max(0, heightMetres);
  const groundKelvin = air.temperatureCelsius + KELVIN_OFFSET;
  const kelvin = temperatureAtHeightKelvin(air, height);
  // Vapour pressure e = ρᵥ·Rᵥ·T, so it falls with the density and the temperature.
  const groundVapour = air.relativeHumidityPercent / 100 * saturationPressureRatio(groundKelvin);
  const vapour = groundVapour * Math.exp(-height / air.humidityScaleHeightMetres) * kelvin / groundKelvin;
  return {
    temperatureCelsius: kelvin - KELVIN_OFFSET,
    pressureKpa: pressureAtHeightPa(air, height) / 1000,
    relativeHumidityPercent: Math.min(100, 100 * vapour / saturationPressureRatio(kelvin))
  };
}

/**
 * Class B: ISO 9613-1 pure-tone atmospheric attenuation coefficient in dB/m.
 * Adopted from Echotect `src/acoustics.js` at commit cb712ef6.
 */
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
