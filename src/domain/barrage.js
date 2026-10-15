import { BLAST } from './constants.js';
import { createRandom, normalDeviate } from './random.js';

export const GROUND_BURST_METRES = 1;

const SHARED_KEYS = Object.freeze(['explosive', 'secondaryShock', 'fireballDecibels', 'fireballSecondsPerSixthRootKilogram', 'linearScaledDistance', 'durationSecondsPerCubeRootKilogram', 'decay', 'riseTimeSeconds']);

/** Class C. */
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
