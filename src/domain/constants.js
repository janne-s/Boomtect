import { VIEW as SHARED_VIEW } from '../shared/domain/constants.js';

export * from '../shared/domain/constants.js';

export const APP_VERSION = '0.78.0';

export const MODEL_VERSION = '35.0.0';

export const TNT_JOULES_PER_KILOGRAM = 4.184e6;

export const THUNDER = Object.freeze({
  maximumSegmentsPerEmitter: 100000,
  stormSegmentBudget: 600000,
  minimumCloudDepthMetres: 100,
  /** Class C. */
  channel: Object.freeze({
    branchJunctionRange: Object.freeze([.1, .95]),
    groundBranchAngleDegrees: Object.freeze([15, 65]),
    subBranchAngleDegrees: Object.freeze([20, 60]),
    cloudBranchElevationDegrees: 20,
    inCloudChannels: 2,
    inCloudElevationDegrees: 10,
    inCloudSpreadDegrees: 50,
    inCloudLengthShare: Object.freeze([.6, 1]),
    inCloudTaper: 4,
    branchLengthMinimumShare: .3,
    subBranchCountShare: .5,
    subBranchLengthShare: .45,
    terminationJunctionRange: Object.freeze([.2, .7]),
    terminationReachRange: Object.freeze([.2, .8])
  }),
  /** B values still need verification against primary sources. */
  storm: Object.freeze({
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
  })
});

export const BLAST = Object.freeze({
  /** Class B: Rigby & Gitterman, MABS 24, 2016, Table 1 (ANFO mid-range). */
  explosives: Object.freeze({
    tnt: Object.freeze({ label: 'TNT', densityKgPerCubicMetre: 1630, detonationMetresPerSecond: 6930 }),
    pe4: Object.freeze({ label: 'PE4 / C4', densityKgPerCubicMetre: 1601, detonationMetresPerSecond: 8193 }),
    compB: Object.freeze({ label: 'Composition B', densityKgPerCubicMetre: 1717, detonationMetresPerSecond: 7980 }),
    petn: Object.freeze({ label: 'PETN', densityKgPerCubicMetre: 1770, detonationMetresPerSecond: 8300 }),
    anfo: Object.freeze({ label: 'ANFO', densityKgPerCubicMetre: 825, detonationMetresPerSecond: 4325 })
  }),
  /** Class B/C: 3.2–4.9 % of the mass (Shock Waves 2024, doi 10.1007/s00193-024-01208-y). */
  secondaryMassShare: .04,
  /** Class C, a render limit. */
  maximumHighBlastSeconds: 2,
  /** Class C, fitted to open-field charge recordings (FBI video, Doc/reference/audio). */
  roar: Object.freeze({
    spectrumHz: Object.freeze([40, 141, 500, 2000, 8000, 16000]),
    spectrumDensity: Object.freeze([1.3e-3, 2.3e-3, 5.3e-4, 4.2e-5, 6e-8, 1e-9]),
    riseSeconds: .01,
    durationDecibels: 30,
    windowSeconds: .05
  }),
  /** Class C. */
  salvoJitter: .15
});

/** Class B: burst height and shell mass (Wharton 1995), drag (Ooki et al. 2006); burst share fitted to Maglieri & Henderson 1973; the rest class C. */
export const FIREWORKS = Object.freeze({
  burstHeightMetresPerMetre: 1400,
  heightSpread: .2,
  tiltDegrees: 2,
  massKilogramsPerCubicMetre: 400,
  dragCoefficient: .75,
  mouthMetres: .7,
  liftShare: .1,
  thumpShare: .01,
  thumpSeconds: .005,
  burstShare: .2,
  starMetresPerSecond: 40,
  starKilogramsPerSquareMetre: 50,
  crackleDelaySeconds: .5,
  crackleSeconds: 1.5,
  starStepSeconds: .02
});

/** Levels and pulse lengths class B (Johnson 2003; Sakurajima, Tungurahua; Doc/reviews/2026-10-22-volcano-recordings.md); the rest class C, fitted to the Dukono, Anak Krakatau and Tavurvur 2014 soundtracks. */
export const VOLCANO = Object.freeze({
  referenceMetres: 1000,
  /** Class C: linear propagation from where the pulse is this share of the air pressure, as a Blast's Z = 20 gives about 4 %. */
  linearPressureShare: .04,
  eruptions: Object.freeze({
    strombolian: Object.freeze({ label: 'Strombolian', equivalentChargeKilograms: 1.6, pulseSeconds: .5, decay: 1, riseTimeSeconds: 5e-5, codaDecibels: -20, codaSeconds: 4, thumpShare: .2 }),
    vulcanian: Object.freeze({ label: 'Vulcanian', equivalentChargeKilograms: 5900, pulseSeconds: 2, decay: 1, riseTimeSeconds: 1.5e-3, codaDecibels: -20, codaSeconds: 3, thumpShare: .7 }),
    strongVulcanian: Object.freeze({ label: 'Strong Vulcanian', equivalentChargeKilograms: 3.9e5, pulseSeconds: 3, decay: 1, riseTimeSeconds: 4e-5, codaDecibels: -20, codaSeconds: 5, thumpShare: .3 })
  }),
  coda: Object.freeze({
    spectrumHz: Object.freeze([20, 100, 400, 900, 1800, 3500, 7000, 16000]),
    spectrumDensity: Object.freeze([5, 1, .0625, .0112, 8.8e-4, 1.43e-4, 7.2e-6, 6.3e-8]),
    riseSeconds: .05,
    falloffDecibels: 30,
    windowSeconds: .05
  }),
  thumps: Object.freeze({
    intervalSeconds: Object.freeze([.05, .4]),
    attackSeconds: .005,
    decaySeconds: .06,
    sizeSpread: .5
  })
});

/** Class C. */
export const UPPER_AIR = Object.freeze({
  topMetres: 80000,
  stepMetres: 500,
  jetHeightMetres: 50000,
  jetWidthMetres: 15000,
  rays: 240,
  coarseRays: 24,
  reachMargin: .1,
  cachedTables: 2000,
  azimuthStepDegrees: 1,
  heightStepMetres: 100,
  absorptionReferenceHz: 20
});

export const FLIGHT = Object.freeze({
  /** Class B: Carlson, NASA TP-1122. */
  bodies: Object.freeze({
    reconnaissance: Object.freeze({ label: 'Reconnaissance aircraft', lengthMetres: 32.7, shapeFactor: .087 }),
    bomber: Object.freeze({ label: 'Medium bomber', lengthMetres: 30, shapeFactor: .088 }),
    rocket: Object.freeze({ label: 'Launch vehicle', lengthMetres: 104.5, shapeFactor: .68 }),
    custom: Object.freeze({ label: 'Custom', lengthMetres: null, shapeFactor: null })
  }),
  /** Class C. */
  focusLimit: 5,
  /** Class C: the arrival time's slope is taken over this, so that a followed path's rounding makes no stationary points. */
  slopeSeconds: .25,
  /** Class C: a fold's third derivative is taken where its slope has changed this much. */
  foldSlopeChange: .01,
  /** Class C: a fold without its two arrivals, on the caustic's shadow side, counts only where the slope comes this near zero. */
  shadowFoldSlope: .05,
  /** Class C: below the focused boom table's top the focused boom gives way to the two rays over this height. */
  focusBlendHeight: .5,
  /** Class C, not fitted. */
  turbulentFront: Object.freeze({
    arrivals: 24,
    frontShare: .5,
    referenceTurbulence: 1e-6,
    riseRatio: 10
  })
});

/** Class B: Krehl & Engemann 1998, Shock Waves 8; the turn, subsonic run, and shape factor class C. */
export const WHIP = Object.freeze({
  accelerationMetres: .45,
  decelerationMetres: .2,
  turnRadiusMetres: .05,
  subsonicMetres: .3,
  subsonicMach: .5,
  stepSeconds: 2e-6
});

/** Class A given β; triple boom after Durrant et al. 2022 and Anderson & Gee 2025, its middle shock fitted (class C). */
export const BOOSTER = Object.freeze({
  stepSeconds: .05,
  maximumSeconds: 600,
  middleShare: .68,
  middleRatio: 1.08
});

export const METEOR = Object.freeze({
  /** Class B. */
  periodCoefficient: 2.81,
  /** Class B. */
  limitRadii: 1e4,
  /** Class C (Popova et al. 2011). */
  breakupPressureRatio: 2,
  breakupPressureSpread: .5
});

export const VIEW = Object.freeze({
  ...SHARED_VIEW,
  barrierPixels: 4,
  macros: Object.freeze({
    energyRange: Object.freeze([3e3, 3e6]),
    crackStraightRange: Object.freeze([3, .2]),
    maximumBranches: 24,
    maximumZigzagDegrees: 45,
    fineTortuosity: Object.freeze([4, 28]),
    cloudRange: Object.freeze([200, 18000]),
    volcanoChargeRange: Object.freeze([.01, 1e6]),
    volcanoRiseRange: Object.freeze([2e-5, 3e-3]),
    volcanoHeightMetres: 6000
  }),
  flash: Object.freeze({
    traverseSeconds: .12,
    fadeSeconds: .2,
    visibleSeconds: 1.2,
    flickerSeconds: .025
  }),
  soundGlowSeconds: .25,
  fireworks: Object.freeze({
    stars: 32,
    burnSeconds: 1.2
  }),
  cloud: Object.freeze({
    puffs: 240,
    puffAlpha: .34,
    anvilSpread: .45,
    flashAlpha: 1.2,
    flashReach: .32,
    flashBlobs: 6,
    blobScatter: .25
  })
});
