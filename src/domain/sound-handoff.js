import { readHandoff } from '../shared/domain/handoff.js';
import { PATH_DIRECT, PATH_SHADOW } from './refraction.js';

/** Class C: one mean direction stands for sound that arrives from many. */

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

export const arrivalDistance = arrivals => energyMean(arrivals, arrivals.metres);

/** Through the air alone: at the ground a reflection's vertical intensity cancels the direct sound's. */
export const arrivalElevation = arrivals => energyMean(arrivals, arrivals.elevations, kind => kind === PATH_DIRECT || kind === PATH_SHADOW);

function propagationContent(scene, terrainEchoes) {
  const terrain = scene.terrain?.enabled ? scene.terrain : null;
  const parts = {
    direct: true,
    'air-absorption': scene.air.absorption,
    refraction: scene.air.refraction,
    turbulence: scene.air.turbulenceStrength > 0,
    ground: scene.ground.enabled,
    forest: scene.ground.enabled && scene.ground.forest,
    surroundings: scene.ground.surroundings && !(terrain?.echoes),
    terrain: Boolean(terrain),
    'terrain-shielding': Boolean(terrain?.shielding),
    'terrain-echoes': Boolean(terrain?.echoes && terrainEchoes)
  };
  return {
    includes: Object.keys(parts).filter(key => parts[key]),
    excludes: ['terrain-echoes'].filter(key => !parts[key])
  };
}

export function soundHandoff({ scene, receiver, channels, arrivals, fullScalePa, startSeconds, file, terrainEchoes, placement = 'listener-and-source', appVersion, id, createdAt }) {
  const direction = fieldArrival(channels);
  return readHandoff({
    format: 'tect.handoff',
    id,
    producer: { app: 'boomtect', version: appVersion, modelVersion: scene.modelVersion },
    kind: 'sound',
    name: receiver.name,
    createdAt,
    place: { name: scene.place.name, latitudeDegrees: scene.place.latitude, longitudeDegrees: scene.place.longitude, datumMetres: scene.terrain ? scene.terrain.datumMetres : null },
    placement,
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
