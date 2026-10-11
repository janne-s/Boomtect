import { VIEW } from './constants.js';
import { PATH_ECHO, PATH_SCATTER, pathProfile, soundSpeedProfile, travelSeconds } from './refraction.js';
import { sourcePosition } from './source-table.js';
import { onGround, terrainSurface } from './terrain.js';

/**
 * The peaks of a rendered pressure's envelope: RMS in windows of VIEW.wavefront.peakWindowSeconds,
 * local maxima within VIEW.wavefront.peakRangeDb of the loudest that rise VIEW.wavefront.peakProminenceDb
 * above the lowest point between them and any louder window, loudest first, at most
 * VIEW.wavefront.peaks. Each has its time (the window's middle, s), its RMS (Pa), and its level
 * under the loudest (dB, ≤ 0).
 */
export function envelopePeaks(samples, startSeconds, sampleRate) {
  const { peakWindowSeconds, peakRangeDb, peakProminenceDb, peaks: most } = VIEW.wavefront;
  const size = Math.max(1, Math.round(peakWindowSeconds * sampleRate));
  const levels = [];
  for (let start = 0; start < samples.length; start += size) {
    let sum = 0;
    const end = Math.min(samples.length, start + size);
    for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
    levels.push(Math.sqrt(sum / (end - start)));
  }
  const loudest = Math.max(0, ...levels);
  if (!(loudest > 0)) return [];
  const decibels = levels.map(level => 20 * Math.log10(Math.max(level, 1e-30) / loudest));
  const found = [];
  decibels.forEach((level, index) => {
    if (level < -peakRangeDb) return;
    if ((index > 0 && decibels[index - 1] > level) || (index + 1 < decibels.length && decibels[index + 1] >= level)) return;
    // Prominence: the deeper of the dips toward the nearest louder window on each side.
    let prominence = Infinity;
    for (const step of [-1, 1]) {
      let lowest = level;
      let at = index + step;
      while (at >= 0 && at < decibels.length && decibels[at] <= level) { lowest = Math.min(lowest, decibels[at]); at += step; }
      if (at >= 0 && at < decibels.length) prominence = Math.min(prominence, level - lowest);
    }
    if (prominence >= peakProminenceDb) found.push({ seconds: startSeconds + (index + .5) * size / sampleRate, rmsPa: levels[index], decibels: level });
  });
  return found.sort((a, b) => b.decibels - a.decibels).slice(0, most);
}

/**
 * Where and when each envelope peak at a receiver left the scene's channels (display only, class C):
 * among the direct, shadow, and ground paths of channel emitters that arrive within the peak's
 * window, those of the strongest one's emitter and flash (sources emitted within a second of it),
 * their energy-weighted centre. Its emission is set so that a front from there reaches the
 * receiver at the peak. Returns [{ emitterId, point, emittedSeconds, decibels }].
 */
export function peakFronts(preparedEmitters, paths, result, receiver, scene) {
  const channels = new Set(['lightning', 'storm']);
  if (!preparedEmitters.some(prepared => channels.has(prepared.emitter.kind))) return [];
  const half = VIEW.wavefront.peakWindowSeconds / 2;
  const profile = soundSpeedProfile(scene.air);
  const to = onGround(terrainSurface(scene.terrain), receiver.positionMetres);
  const energyOf = index => {
    const sources = preparedEmitters[paths.emitter[index]].sources;
    return (sources.amplitudePaMetres[paths.source[index]] * paths.amplitudeScale[index] / Math.max(paths.spreadMetres[index], 1e-9)) ** 2;
  };
  const fronts = [];
  for (const peak of envelopePeaks(result.samples, result.startSeconds, result.sampleRate)) {
    const arriving = [];
    for (let index = 0; index < paths.count; index += 1) {
      const kind = paths.kind[index];
      if (kind === PATH_ECHO || kind === PATH_SCATTER || Math.abs(paths.seconds[index] - peak.seconds) > half) continue;
      if (!channels.has(preparedEmitters[paths.emitter[index]].emitter.kind)) continue;
      arriving.push(index);
    }
    if (!arriving.length) continue;
    const strongest = arriving.reduce((best, index) => (energyOf(index) > energyOf(best) ? index : best));
    const emitterIndex = paths.emitter[strongest];
    const { sources, emitter } = preparedEmitters[emitterIndex];
    const flashSeconds = sources.emissionSeconds[paths.source[strongest]];
    let weight = 0;
    const centre = { x: 0, y: 0, z: 0 };
    for (const index of arriving) {
      if (paths.emitter[index] !== emitterIndex || Math.abs(sources.emissionSeconds[paths.source[index]] - flashSeconds) > 1) continue;
      const energy = energyOf(index);
      const position = sourcePosition(sources, paths.source[index]);
      weight += energy;
      centre.x += energy * position.x; centre.y += energy * position.y; centre.z += energy * position.z;
    }
    if (!(weight > 0)) continue;
    const point = { x: centre.x / weight, y: centre.y / weight, z: centre.z / weight };
    const along = pathProfile(profile, point, to);
    fronts.push({ emitterId: emitter.id, point, emittedSeconds: peak.seconds - travelSeconds(along, point, to), decibels: peak.decibels });
  }
  return fronts;
}
