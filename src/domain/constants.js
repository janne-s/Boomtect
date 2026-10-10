/**
 * Physical constants and engineering limits. Coordinates are metres in a right-handed frame:
 * x east, y north, z up, with the ground plane at z = 0.
 */

export const MODEL_VERSION = '19.0.0';

export const SAMPLE_RATE_HZ = 48000;

export const GAMMA_AIR = 1.4;
export const GAS_CONSTANT_AIR_J_PER_KG_KELVIN = 287.05;
export const KELVIN_OFFSET = 273.15;

/** ISA troposphere lapse rate (ISO 2533), the default temperature gradient; and standard gravity. */
export const ISA_LAPSE_RATE_KELVIN_PER_METRE = .0065;
export const STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED = 9.80665;

export const MAXIMUM_RENDER_SECONDS = 300;
/** Segments of one flash's main channel and branches; a storm shares STORM_SEGMENT_BUDGET among its branches. */
export const MAXIMUM_SEGMENTS_PER_EMITTER = 100000;
export const STORM_SEGMENT_BUDGET = 600000;
export const MAXIMUM_SOURCES = 1500000;
export const MAXIMUM_EMITTERS = 8;
export const MAXIMUM_RECEIVERS = 8;
export const SCENE_EXTENT_METRES = 50000;
export const MAXIMUM_HEIGHT_METRES = 20000;
