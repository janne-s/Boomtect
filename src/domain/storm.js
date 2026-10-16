import { THUNDER } from './constants.js';
import { lightningFlash } from './lightning.js';
import { createRandom, normalDeviate, uniform } from '../shared/domain/random.js';

const logUniform = (random, [low, high]) => low * (high / low) ** random();
const lognormal = (random, sigma) => Math.exp(sigma * normalDeviate(random) - sigma ** 2 / 2);

export function stormFlashes(storm, surface = null) {
  return [...stormFlashSequence(storm, surface)];
}

export function* stormFlashSequence(storm, surface = null) {
  const groundAt = surface ? surface.heightAt : () => 0;
  const random = createRandom(storm.seed);
  const specs = [];
  for (let index = 0; index < storm.flashCount; index += 1) {
    const startSeconds = storm.startSeconds + random() * storm.durationSeconds;
    const radius = storm.radiusMetres * Math.sqrt(random());
    const angle = 2 * Math.PI * random();
    const x = storm.centreMetres.x + radius * Math.cos(angle);
    const y = storm.centreMetres.y + radius * Math.sin(angle);
    const ground = random() < storm.groundFlashShare;
    const seed = Math.floor(random() * 0x100000000);
    const energy = storm.energyJoulesPerMetre * lognormal(random, storm.energySpread);
    const depth = storm.cloudTopMetres - storm.cloudBaseMetres;
    const shared = {
      seed, startSeconds, groundAt,
      segmentLengthMetres: storm.segmentLengthMetres,
      tortuosityDegrees: storm.tortuosityDegrees,
      macroStepMetres: storm.macroStepMetres,
      macroTortuosityDegrees: storm.macroTortuosityDegrees,
      branchDepth: storm.branchDepth,
      branchEnergyRatio: storm.branchEnergyRatio,
      energyVariation: storm.energyVariation,
      strokeIntervalSpread: THUNDER.storm.strokeIntervalSpread,
      subsequentStrokeEnergyRatio: uniform(random, THUNDER.storm.laterStrokeEnergy),
      branchCount: Math.round(storm.branchCount * (.5 + random()))
    };
    if (ground) {
      const height = storm.cloudBaseMetres + random() * THUNDER.storm.groundTopRiseShare * depth;
      const lean = height * THUNDER.storm.groundLean * random();
      const leanAngle = 2 * Math.PI * random();
      let strokeCount = 1;
      while (strokeCount < THUNDER.storm.groundStrokeMaximum && random() < 1 - 1 / THUNDER.storm.groundStrokeMean) strokeCount += 1;
      specs.push({
        ...shared,
        type: 'cloud-to-ground',
        baseMetres: { x, y, z: groundAt(x, y) },
        topMetres: { x: x + lean * Math.cos(leanAngle), y: y + lean * Math.sin(leanAngle), z: height },
        branchLengthRatio: THUNDER.storm.groundBranchLengthRatio,
        energyJoulesPerMetre: energy,
        channelSpeedMetresPerSecond: logUniform(random, THUNDER.storm.returnStrokeSpeed),
        strokeCount,
        strokeIntervalSeconds: THUNDER.storm.groundStrokeIntervalMedianSeconds,
        newTerminationProbability: storm.newTerminationProbability,
        currentDecayHeightMetres: storm.currentDecayHeightMetres,
        inCloudLengthMetres: storm.inCloudLengthMetres,
        inCloudEnergyRatio: storm.inCloudEnergyRatio,
        inCloudSpeedMetresPerSecond: storm.inCloudSpeedMetresPerSecond
      });
    } else {
      const [low, high] = THUNDER.storm.cloudLayer;
      const z = storm.cloudBaseMetres + uniform(random, [low, high]) * depth;
      const channelLength = uniform(random, THUNDER.storm.cloudChannelLength);
      const heading = 2 * Math.PI * random();
      const rise = (2 * random() - 1) * THUNDER.storm.cloudChannelRise * channelLength;
      const half = channelLength / 2;
      const clampZ = value => Math.min(storm.cloudTopMetres, Math.max(storm.cloudBaseMetres, value));
      specs.push({
        ...shared,
        type: 'intra-cloud',
        baseMetres: { x: x - half * Math.cos(heading), y: y - half * Math.sin(heading), z: clampZ(z - rise / 2) },
        topMetres: { x: x + half * Math.cos(heading), y: y + half * Math.sin(heading), z: clampZ(z + rise / 2) },
        branchLengthRatio: THUNDER.storm.cloudBranchLengthRatio,
        energyJoulesPerMetre: energy * THUNDER.storm.cloudEnergyScale,
        channelSpeedMetresPerSecond: logUniform(random, THUNDER.storm.cloudChannelSpeed),
        strokeCount: Math.round(uniform(random, THUNDER.storm.cloudPulseCount)),
        strokeIntervalSeconds: THUNDER.storm.cloudPulseIntervalMedianSeconds,
        newTerminationProbability: 0
      });
    }
  }
  specs.sort((a, b) => a.startSeconds - b.startSeconds);
  let budget = THUNDER.stormSegmentBudget;
  for (const spec of specs) {
    const flash = lightningFlash({ ...spec, branchBudget: Math.max(0, budget) });
    budget -= flash.channels.reduce((sum, channel) => sum + channel.segments.length, 0);
    yield flash;
  }
}
