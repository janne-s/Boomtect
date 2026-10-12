import { BLAST, FIREWORKS, STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED } from './constants.js';
import { airDensityKilogramsPerCubicMetre } from './air.js';
import { createRandom, normalDeviate } from './random.js';

/**
 * A fireworks display: shells fired from mortars over an area in salvos, as a barrage's rounds
 * land, each heard as its mortar's thump on the ground, its burst high in the air a flight time
 * later, and, for a share of the shells, its crackling stars as a swarm of tiny pops. Each is a
 * blast of its own; the physics and its classes are FIREWORKS'. The muzzle flash and the shell's
 * flight are not sounds here.
 */

const G = STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED;
/** Shell diameters the burst-height fit spans, metres. */
const DIAMETER_RANGE = Object.freeze([.03, .4]);

/**
 * A shell fired straight up in still air of density ρ, as a sphere: its launch speed for the top
 * of its flight at `heightMetres`, and the time it takes there (class A for the drag law, with
 * k = ρ·C_D·A/(2m): H = ln(1 + k·v₀²/g)/(2k), t = atan(v₀·√(k/g))/√(g·k)).
 */
export function shellFlight(diameterMetres, heightMetres, density) {
  const mass = FIREWORKS.massKilogramsPerCubicMetre * diameterMetres ** 3;
  const k = density * FIREWORKS.dragCoefficient * Math.PI * diameterMetres ** 2 / 4 / (2 * mass);
  const launchMetresPerSecond = Math.sqrt(G * Math.expm1(2 * k * heightMetres) / k);
  return { massKilograms: mass, launchMetresPerSecond, flightSeconds: Math.atan(launchMetresPerSecond * Math.sqrt(k / G)) / Math.sqrt(G * k) };
}

/**
 * The shells of a display in firing order: each with its seed, diameter, mass, mortar (on the
 * ground), launch time, burst point (its height above the ground at the mortar), burst time, and
 * whether its stars crackle. Deterministic from the display and the air.
 */
export function fireworksShells(fireworks, air) {
  const random = createRandom(fireworks.seed);
  const density = airDensityKilogramsPerCubicMetre(air.pressureKpa * 1000, air.temperatureCelsius);
  const salvos = Math.ceil(fireworks.shellCount / fireworks.salvoSize);
  const interval = salvos > 1 ? fireworks.durationSeconds / (salvos - 1) : 0;
  const shells = [];
  for (let salvo = 0; salvo < salvos; salvo += 1) {
    const salvoSeconds = Math.max(0, salvo * interval + (random() - .5) * 2 * BLAST.salvoJitter * interval);
    const count = Math.min(fireworks.salvoSize, fireworks.shellCount - shells.length);
    for (let shell = 0; shell < count; shell += 1) {
      const radius = fireworks.radiusMetres * Math.sqrt(random());
      const angle = 2 * Math.PI * random();
      const sigma = fireworks.diameterSpread;
      const diameter = Math.min(DIAMETER_RANGE[1], Math.max(DIAMETER_RANGE[0], fireworks.shellDiameterMillimetres / 1000 * Math.exp(sigma * normalDeviate(random) - sigma ** 2 / 2)));
      const height = FIREWORKS.burstHeightMetresPerMetre * diameter * Math.exp(FIREWORKS.heightSpread * normalDeviate(random));
      const tilt = FIREWORKS.tiltDegrees * Math.PI / 180 * normalDeviate(random);
      const tiltHeading = 2 * Math.PI * random();
      const crackles = random() < fireworks.crackleShare;
      const seed = Math.floor(random() * 0x100000000);
      const launchSeconds = fireworks.startSeconds + salvoSeconds + random() * fireworks.salvoSpreadSeconds;
      const mortar = { x: fireworks.centreMetres.x + radius * Math.cos(angle), y: fireworks.centreMetres.y + radius * Math.sin(angle), z: 0 };
      const flight = shellFlight(diameter, height, density);
      shells.push({
        id: `${fireworks.id}:${shells.length}`, seed, diameterMetres: diameter, massKilograms: flight.massKilograms, crackles,
        mortarMetres: mortar, launchSeconds,
        burstMetres: { x: mortar.x + height * Math.tan(tilt) * Math.sin(tiltHeading), y: mortar.y + height * Math.tan(tilt) * Math.cos(tiltHeading), z: height },
        burstSeconds: launchSeconds + flight.flightSeconds
      });
    }
  }
  return shells.sort((a, b) => a.launchSeconds - b.launchSeconds);
}

/**
 * A crackling shell's pops: each star leaves the burst at FIREWORKS.starMetresPerSecond in a seeded
 * direction, slowed by drag in air of density ρ and pulled down; each of its pops comes at a seeded
 * time within the crackle and where the star is then. Positions are heights above the ground at
 * the mortar, as the burst's, kept a metre above it.
 */
export function shellPops(shell, fireworks, density) {
  const random = createRandom(shell.seed);
  const pull = density / (2 * FIREWORKS.starKilogramsPerSquareMetre);
  const step = FIREWORKS.starStepSeconds;
  const steps = Math.ceil((FIREWORKS.crackleDelaySeconds + FIREWORKS.crackleSeconds) / step);
  const pops = [];
  for (let star = 0; star < fireworks.starCount; star += 1) {
    // A direction uniform over the sphere.
    const up = 2 * random() - 1;
    const around = 2 * Math.PI * random();
    const across = Math.sqrt(1 - up * up);
    let velocity = [FIREWORKS.starMetresPerSecond * across * Math.cos(around), FIREWORKS.starMetresPerSecond * across * Math.sin(around), FIREWORKS.starMetresPerSecond * up];
    let position = [shell.burstMetres.x, shell.burstMetres.y, shell.burstMetres.z];
    const track = [position];
    // Midpoint steps of dv/dt = −(ρ/2β)|v|v − g.
    const rate = v => { const drag = pull * Math.hypot(...v); return [-drag * v[0], -drag * v[1], -drag * v[2] - G]; };
    for (let index = 0; index < steps; index += 1) {
      const a = rate(velocity);
      const half = velocity.map((value, axis) => value + a[axis] * step / 2);
      const b = rate(half);
      position = position.map((value, axis) => value + half[axis] * step);
      velocity = velocity.map((value, axis) => value + b[axis] * step);
      track.push(position);
    }
    for (let pop = 0; pop < fireworks.popsPerStar; pop += 1) {
      const after = FIREWORKS.crackleDelaySeconds + random() * FIREWORKS.crackleSeconds;
      const at = after / step;
      const index = Math.min(steps - 1, Math.floor(at));
      const share = at - index;
      const [x, y, z] = track[index].map((value, axis) => value + (track[index + 1][axis] - value) * share);
      pops.push({ positionMetres: { x, y, z: Math.max(1, z) }, startSeconds: shell.burstSeconds + after });
    }
  }
  return pops.sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * The display's blasts, as a blast's charge (kg TNT), place (height above the ground), and onset, a
 * thump also with its positive phase per cube root of the charge: `events`, the mortars' thumps and the shells'
 * bursts, in time order, and `pops`, the crackling stars'. Deterministic from the display and the air.
 */
export function fireworksBlasts(fireworks, air) {
  const density = airDensityKilogramsPerCubicMetre(air.pressureKpa * 1000, air.temperatureCelsius);
  const shells = fireworksShells(fireworks, air);
  const events = [];
  const pops = [];
  for (const shell of shells) {
    const thump = FIREWORKS.thumpShare * FIREWORKS.liftShare * shell.massKilograms;
    events.push({
      id: `${shell.id}:thump`, seed: shell.seed, positionMetres: { ...shell.mortarMetres, z: FIREWORKS.mouthMetres }, startSeconds: shell.launchSeconds,
      chargeKilograms: thump, durationSecondsPerCubeRootKilogram: FIREWORKS.thumpSeconds / Math.cbrt(thump)
    });
    events.push({
      id: `${shell.id}:burst`, seed: shell.seed ^ 0x5bd1e995, positionMetres: shell.burstMetres, startSeconds: shell.burstSeconds,
      chargeKilograms: FIREWORKS.burstShare * shell.massKilograms
    });
    if (!shell.crackles) continue;
    shellPops(shell, fireworks, density).forEach((pop, index) => pops.push({
      id: `${shell.id}:pop${index}`, seed: shell.seed + index + 1, ...pop,
      chargeKilograms: fireworks.popMilligrams * 1e-6
    }));
  }
  return { events: events.sort((a, b) => a.startSeconds - b.startSeconds), pops };
}
