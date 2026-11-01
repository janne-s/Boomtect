import { BLEVE, GAS_EXPLOSION, TANK_FARM } from './constants.js';
import { fireballOf } from './bleve.js';
import { createRandom, normalDeviate } from '../shared/domain/random.js';

const STANDARD_AIR = Object.freeze({ pressureKpa: 101.325, temperatureCelsius: 15 });
const SEED_RANGE = 0x100000000;
const VESSEL_SEED = 0x27d4eb2f;

/** Rows along the heading, centred on the farm; the first tank sits at the back left corner. */
export function tankFarmLayout(farm) {
  const columns = Math.ceil(Math.sqrt(farm.tankCount));
  const rows = Math.ceil(farm.tankCount / columns);
  const heading = farm.headingDegrees * Math.PI / 180;
  const [alongX, alongY] = [Math.sin(heading), Math.cos(heading)];
  return Array.from({ length: farm.tankCount }, (_, index) => {
    const along = (Math.floor(index / columns) - (rows - 1) / 2) * farm.spacingMetres;
    const across = (index % columns - (columns - 1) / 2) * farm.spacingMetres;
    return { x: farm.centreMetres.x + along * alongX + across * alongY, y: farm.centreMetres.y + along * alongY - across * alongX, z: 0 };
  });
}

export const openingSeed = farm => (farm.seed ^ 0x5bd1e995) >>> 0;

export function openingExplosion(farm) {
  const fuel = TANK_FARM.openingFuels[farm.fluid];
  if (!fuel || !(farm.openingCloudCubicMetres > 0)) return null;
  const ignition = tankFarmLayout(farm)[Math.min(farm.tankCount, farm.ignitionTank) - 1];
  return {
    id: `${farm.id}:opening`, name: farm.name, kind: 'gasExplosion', enabled: true, seed: openingSeed(farm), startSeconds: farm.startSeconds,
    positionMetres: ignition, cloudCubicMetres: farm.openingCloudCubicMetres, fuel, congestion: TANK_FARM.openingCongestion, confinement: 'open', ignition: 'spark',
    fireballDecibels: -20, fireballSecondsPerSixthRootKilogram: .92, puffBlend: GAS_EXPLOSION.roar.puffs.defaultBlend, denseRegions: 0, riseTimeSeconds: farm.riseTimeSeconds
  };
}

/**
 * Class C: each tank's BLEVE, the fire reaching it from the first tank and the first fireball reaching it hurrying it once; without an opening cloud the first tank fails at the start.
 * Each tank's failure pressure and fill spread as in Birk et al. 2007, drawn apart from the timing.
 */
export function tankFarmTanks(farm) {
  const random = createRandom(farm.seed);
  const positions = tankFarmLayout(farm);
  const ignition = positions[Math.min(farm.tankCount, farm.ignitionTank) - 1];
  const sigma = farm.heatingSpread;
  const spread = createRandom((farm.seed ^ VESSEL_SEED) >>> 0);
  const tanks = positions.map((positionMetres, index) => {
    const vessel = random() < farm.otherShare ? farm.otherVessel : farm.vessel;
    const { label, ...numbers } = BLEVE.vessels[vessel];
    const failureBar = numbers.failureBar * Math.exp(TANK_FARM.failureSpread * normalDeviate(spread));
    const fillShare = Math.min(.95, Math.max(.05, numbers.fillShare + TANK_FARM.fillSpread * normalDeviate(spread)));
    const heating = farm.heatingSeconds * Math.cbrt(numbers.vesselCubicMetres / TANK_FARM.referenceCubicMetres) * Math.exp(sigma * normalDeviate(random) - sigma ** 2 / 2);
    const arrival = Math.hypot(positionMetres.x - ignition.x, positionMetres.y - ignition.y) / farm.spreadMetresPerSecond;
    return {
      id: `${farm.id}:${index}`, name: `${farm.name} ${index + 1}`, kind: 'bleve', enabled: true, seed: Math.floor(random() * SEED_RANGE),
      startSeconds: farm.startSeconds + arrival + heating, positionMetres, fluid: farm.fluid, ...numbers, failureBar, fillShare, blastShare: 1,
      fireballDecibels: farm.fireballDecibels, thumpDecibels: farm.thumpDecibels, swellDecibels: farm.swellDecibels, fireballSecondsPerSixthRootKilogram: BLEVE.roarSecondsPerSixthRootKilogram, riseTimeSeconds: farm.riseTimeSeconds
    };
  });
  const pending = new Set(tanks);
  const hurried = new Set();
  while (pending.size) {
    const failing = [...pending].reduce((first, tank) => (tank.startSeconds < first.startSeconds ? tank : first));
    pending.delete(failing);
    const reach = (fireballOf(failing, STANDARD_AIR)?.diameterMetres ?? 0) / 2;
    for (const tank of pending) {
      const distance = Math.hypot(tank.positionMetres.x - failing.positionMetres.x, tank.positionMetres.y - failing.positionMetres.y);
      if (distance > reach || hurried.has(tank)) continue;
      tank.startSeconds = failing.startSeconds + TANK_FARM.dominoShare * (tank.startSeconds - failing.startSeconds);
      hurried.add(tank);
    }
  }
  tanks.sort((a, b) => a.startSeconds - b.startSeconds);
  const wait = openingExplosion(farm) ? 0 : tanks[0].startSeconds - farm.startSeconds;
  for (const tank of tanks) tank.startSeconds -= wait;
  return tanks;
}

export const tankFarmRounds = farm => [...(openingExplosion(farm) ? [openingExplosion(farm)] : []), ...tankFarmTanks(farm)];
