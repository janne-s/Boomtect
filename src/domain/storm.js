import { MAXIMUM_SEGMENTS_PER_EMITTER } from './constants.js';
import { lightningFlash } from './lightning.js';
import { createRandom, normalDeviate } from './random.js';

/**
 * Flash statistics of a generated storm. Values marked B are typical literature figures that still
 * need verification against primary sources; values marked C are synthetic choices.
 */
const STORM = Object.freeze({
  groundStrokeMean: 3.5,                      // B: strokes per ground flash, typically 3–5 (CIGRÉ C4.407)
  groundStrokeMaximum: 10,
  groundStrokeIntervalMedianSeconds: .06,     // B: geometric mean interstroke interval (CIGRÉ C4.407)
  strokeIntervalSpread: .6,                   // C: lognormal σ
  laterStrokeEnergy: [.3, .7],                // C
  returnStrokeSpeed: [5e7, 2e8],              // B: m/s, log-uniform
  groundTopRiseShare: .3,                     // C: tops reach this share into the cloud depth
  groundLean: .15,                            // C: horizontal offset of the top per height
  groundBranchLengthRatio: .35,               // C
  cloudPulseCount: [2, 6],                    // C: K-change-like pulses
  cloudPulseIntervalMedianSeconds: .04,       // C
  cloudChannelSpeed: [1e5, 1e6],              // B: leader speeds, m/s, log-uniform
  cloudChannelLength: [2000, 8000],           // C: metres
  cloudChannelRise: .1,                       // C: vertical share of a cloud channel
  cloudLayer: [.3, .9],                       // C: cloud flashes sit between these shares of the cloud depth
  cloudEnergyScale: .3,                       // C: cloud channels relative to ground channels
  cloudBranchLengthRatio: .2                  // C
});

const logUniform = (random, [low, high]) => low * (high / low) ** random();
const uniform = (random, [low, high]) => low + random() * (high - low);
const lognormal = (random, sigma) => Math.exp(sigma * normalDeviate(random) - sigma ** 2 / 2);

/**
 * Deterministic flashes of a storm: positions uniform over a disc, onsets uniform over the
 * duration, a seeded mix of ground and cloud flashes, and lognormal energies. Every flash gets
 * its own seed for its channel shape.
 */
export function stormFlashes(storm) {
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
      seed, startSeconds,
      segmentLengthMetres: storm.segmentLengthMetres,
      tortuosityDegrees: storm.tortuosityDegrees,
      macroStepMetres: storm.macroStepMetres,
      macroTortuosityDegrees: storm.macroTortuosityDegrees,
      branchDepth: storm.branchDepth,
      branchEnergyRatio: storm.branchEnergyRatio,
      energyVariation: storm.energyVariation,
      strokeIntervalSpread: STORM.strokeIntervalSpread,
      subsequentStrokeEnergyRatio: uniform(random, STORM.laterStrokeEnergy),
      branchCount: Math.round(storm.branchCount * (.5 + random()))
    };
    if (ground) {
      const height = storm.cloudBaseMetres + random() * STORM.groundTopRiseShare * depth;
      const lean = height * STORM.groundLean * random();
      const leanAngle = 2 * Math.PI * random();
      let strokeCount = 1;
      while (strokeCount < STORM.groundStrokeMaximum && random() < 1 - 1 / STORM.groundStrokeMean) strokeCount += 1;
      specs.push({
        ...shared,
        type: 'cloud-to-ground',
        baseMetres: { x, y, z: 0 },
        topMetres: { x: x + lean * Math.cos(leanAngle), y: y + lean * Math.sin(leanAngle), z: height },
        branchLengthRatio: STORM.groundBranchLengthRatio,
        energyJoulesPerMetre: energy,
        channelSpeedMetresPerSecond: logUniform(random, STORM.returnStrokeSpeed),
        strokeCount,
        strokeIntervalSeconds: STORM.groundStrokeIntervalMedianSeconds,
        newTerminationProbability: storm.newTerminationProbability
      });
    } else {
      const [low, high] = STORM.cloudLayer;
      const z = storm.cloudBaseMetres + uniform(random, [low, high]) * depth;
      const channelLength = uniform(random, STORM.cloudChannelLength);
      const heading = 2 * Math.PI * random();
      const rise = (2 * random() - 1) * STORM.cloudChannelRise * channelLength;
      const half = channelLength / 2;
      const clampZ = value => Math.min(storm.cloudTopMetres, Math.max(storm.cloudBaseMetres, value));
      specs.push({
        ...shared,
        type: 'intra-cloud',
        baseMetres: { x: x - half * Math.cos(heading), y: y - half * Math.sin(heading), z: clampZ(z - rise / 2) },
        topMetres: { x: x + half * Math.cos(heading), y: y + half * Math.sin(heading), z: clampZ(z + rise / 2) },
        branchLengthRatio: STORM.cloudBranchLengthRatio,
        energyJoulesPerMetre: energy * STORM.cloudEnergyScale,
        channelSpeedMetresPerSecond: logUniform(random, STORM.cloudChannelSpeed),
        strokeCount: Math.round(uniform(random, STORM.cloudPulseCount)),
        strokeIntervalSeconds: STORM.cloudPulseIntervalMedianSeconds,
        newTerminationProbability: 0
      });
    }
  }
  specs.sort((a, b) => a.startSeconds - b.startSeconds);
  let budget = MAXIMUM_SEGMENTS_PER_EMITTER * 4;
  return specs.map(spec => {
    const flash = lightningFlash({ ...spec, segmentBudget: budget });
    budget -= flash.channels.reduce((sum, channel) => sum + channel.segments.length, 0);
    return flash;
  });
}
