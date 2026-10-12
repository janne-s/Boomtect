import { BLAST } from './constants.js';
import { createRandom, normalDeviate } from './random.js';

/**
 * A barrage: rounds that land over an area in salvos, as artillery fires. Each round is a blast of
 * its own, so its physics is the blast's; where and when the rounds land is seeded and class C.
 *
 * The salvos are spread evenly over the duration with some jitter, and the rounds of one salvo land
 * within its spread, uniformly over a disc. Charges spread lognormally about the mean, keeping it.
 * A share of the rounds burst in the air at a height; the rest on the ground.
 */

/** Height of a round that bursts on the ground, as the single blast's default. */
export const GROUND_BURST_METRES = 1;

const SHARED_KEYS = Object.freeze(['explosive', 'secondaryShock', 'fireballDecibels', 'fireballSecondsPerSixthRootKilogram', 'linearScaledDistance', 'durationSecondsPerCubeRootKilogram', 'decay', 'riseTimeSeconds']);

/** The rounds of a barrage as blasts in landing order, each with its own seed, position above the ground, onset, and charge. */
export function barrageRounds(barrage) {
  const random = createRandom(barrage.seed);
  const salvos = Math.ceil(barrage.roundCount / barrage.salvoSize);
  const interval = salvos > 1 ? barrage.durationSeconds / (salvos - 1) : 0;
  const shared = Object.fromEntries(SHARED_KEYS.map(key => [key, barrage[key]]));
  const rounds = [];
  for (let salvo = 0; salvo < salvos; salvo += 1) {
    const salvoSeconds = Math.max(0, salvo * interval + (random() - .5) * 2 * BLAST.salvoJitter * interval);
    const count = Math.min(barrage.salvoSize, barrage.roundCount - rounds.length);
    for (let round = 0; round < count; round += 1) {
      const radius = barrage.radiusMetres * Math.sqrt(random());
      const angle = 2 * Math.PI * random();
      const air = random() < barrage.airburstShare;
      const sigma = barrage.chargeSpread;
      rounds.push({
        ...shared,
        id: `${barrage.id}:${rounds.length}`,
        kind: 'blast',
        seed: Math.floor(random() * 0x100000000),
        startSeconds: barrage.startSeconds + salvoSeconds + random() * barrage.salvoSpreadSeconds,
        positionMetres: {
          x: barrage.centreMetres.x + radius * Math.cos(angle),
          y: barrage.centreMetres.y + radius * Math.sin(angle),
          z: air ? barrage.airburstHeightMetres : GROUND_BURST_METRES
        },
        chargeKilograms: barrage.chargeKilograms * Math.exp(sigma * normalDeviate(random) - sigma ** 2 / 2)
      });
    }
  }
  return rounds.sort((a, b) => a.startSeconds - b.startSeconds);
}
