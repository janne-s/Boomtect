import { readHandoff } from './handoff.js';
import { PATH_DIRECT, PATH_SHADOW } from './refraction.js';

/**
 * A microphone's sound as a handoff (`handoff.js`) for a tect that adds its own echoes, such as
 * Echotect: the omni pressure, where it was heard, and one direction and distance to place the
 * sound's source at: the compass direction from the rendered field, the elevation and distance
 * from its paths. Class C: thunder and a boom arrive from many directions at once, and one mean
 * direction stands for them all.
 */

/**
 * The mean direction the sound comes from, compass degrees and elevation, from the active intensity
 * of a first-order AmbiX field (W times the north, west, and up components, summed over the whole
 * sound, so it is weighted by energy). Null without a first-order field or a sound.
 */
export function fieldArrival(channels) {
  if (channels.length < 4) return null;
  const [w, west, up, north] = channels;
  let towardNorth = 0;
  let towardWest = 0;
  let towardUp = 0;
  for (let index = 0; index < w.length; index += 1) {
    towardNorth += w[index] * north[index];
    towardWest += w[index] * west[index];
    towardUp += w[index] * up[index];
  }
  const level = Math.hypot(towardNorth, towardWest);
  if (!(Math.hypot(level, towardUp) > 0)) return null;
  return {
    azimuthDegrees: ((Math.atan2(-towardWest, towardNorth) * 180 / Math.PI) + 360) % 360,
    elevationDegrees: Math.atan2(towardUp, level) * 180 / Math.PI
  };
}

/** A value of the sound's paths (`arrivalTable`) weighted by their energy, over the paths `include` keeps; null without any. */
function energyMean(arrivals, values, include = () => true) {
  let weight = 0;
  let sum = 0;
  for (let index = 0; index < arrivals.count; index += 1) {
    const energy = 10 ** (arrivals.levels[index] / 10);
    if (!include(arrivals.kinds[index]) || !Number.isFinite(energy) || !Number.isFinite(values[index])) continue;
    weight += energy;
    sum += energy * values[index];
  }
  return weight > 0 ? sum / weight : null;
}

/** The length of the sound's paths, metres, weighted by their energy. */
export const arrivalDistance = arrivals => energyMean(arrivals, arrivals.metres);

/**
 * The elevation the sound comes from, degrees, over the paths that come through the air alone. At
 * the ground the field cannot tell it: a reflection arrives with the direct sound from below, and
 * their vertical intensities cancel.
 */
export const arrivalElevation = arrivals => energyMean(arrivals, arrivals.elevations, kind => kind === PATH_DIRECT || kind === PATH_SHADOW);

/** Which parts of the propagation a scene's sound holds. */
function propagationContent(scene, terrainEchoes) {
  const terrain = scene.terrain?.enabled ? scene.terrain : null;
  const parts = {
    direct: true,
    'air-absorption': scene.air.absorption,
    refraction: scene.air.refraction,
    turbulence: scene.air.turbulenceStrength > 0,
    ground: scene.ground.enabled,
    forest: scene.ground.enabled && scene.ground.forest,
    terrain: Boolean(terrain),
    'terrain-shielding': Boolean(terrain?.shielding),
    'terrain-echoes': Boolean(terrain?.echoes && terrainEchoes)
  };
  return {
    includes: Object.keys(parts).filter(key => parts[key]),
    excludes: ['terrain-echoes'].filter(key => !parts[key])
  };
}

/**
 * The handoff of one microphone's pressure. `channels` is its field on the export's timeline (the
 * omni channel first), `arrivals` its arrival table, `fullScalePa` the pressure a sample of 1 stands
 * for, and `startSeconds` when the first sample is from the event's start.
 */
export function soundHandoff({ scene, receiver, channels, arrivals, fullScalePa, startSeconds, file, terrainEchoes, appVersion, id, createdAt }) {
  const direction = fieldArrival(channels);
  return readHandoff({
    format: 'tect.handoff',
    id,
    producer: { app: 'boomtect', version: appVersion, modelVersion: scene.modelVersion },
    kind: 'sound',
    name: receiver.name,
    createdAt,
    place: { name: scene.place.name, latitudeDegrees: scene.place.latitude, longitudeDegrees: scene.place.longitude, datumMetres: scene.terrain ? scene.terrain.datumMetres : null },
    air: { temperatureCelsius: scene.air.temperatureCelsius, relativeHumidityPercent: scene.air.relativeHumidityPercent, pressureKpa: scene.air.pressureKpa },
    listener: {
      positionMetres: { east: receiver.positionMetres.x, north: receiver.positionMetres.y },
      heightAboveGroundMetres: receiver.positionMetres.z,
      headingDegrees: receiver.headingDegrees,
      pitchDegrees: receiver.pitchDegrees
    },
    arrival: direction && { ...direction, elevationDegrees: arrivalElevation(arrivals) ?? direction.elevationDegrees, distanceMetres: arrivalDistance(arrivals) },
    audio: { sampleRateHz: scene.render.sampleRate, channels: 1, layout: 'pressure', sampleFormat: 'ieee-float32', fullScalePa, startSeconds, file },
    content: propagationContent(scene, terrainEchoes),
    reliability: 'C'
  });
}
