import { VIEW as SHARED_VIEW } from '../shared/domain/constants.js';

export * from '../shared/domain/constants.js';

export const APP_VERSION = '0.80.0';

export const MODEL_VERSION = '36.2.0';

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

/** Strength pressures class B (TNO Multi-Energy, Van den Berg 1985; GAME, Eggen 1998, Figure 10); source pressure class B from the GAME correlation (Eggen 1998, HSE CRR 202/1998 §6.7: P₀ = a(VBR·L/D)^b S_L^2.7 D^0.7 bar, spark ignition, fitted over 0.01–10 bar, D 0.019–0.82 m, VBR 5–50 %, S_L 0.40–0.66 m/s); burning velocities of methane, propane and ethylene as GAME used them, the others class B from NFPA 68 Table D.1 and extrapolated; mixture energies class A from heats of combustion at stoichiometry, 15 °C; congestion presets class C, pipe rack after GAME Annex D. Doc/design/architecture-decision-8-gas-explosion.md. */
export const GAS_EXPLOSION = Object.freeze({
  referenceMetres: 1000,
  strengthPressuresKpa: Object.freeze([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]),
  tntMegajoulesPerKilogram: 4.68,
  expansionRatio: 7.5,
  linearPressureShare: VOLCANO.linearPressureShare,
  pressureWaveStrengths: Object.freeze([3, 7]),
  /** Class B: the Multi-Energy blast curve, digitised from GAME (Eggen 1998) Figure 1: the strengths 6–10 merge into one curve (scaled distance R̄ = R/(E/p₀)^⅓, overpressure ΔP̄ = ΔP/p₀); strengths 1–5 keep their source overpressure to R̄ 0.7, then fall as 0.76, 0.75, 0.71, 0.66, and 0.61 of it over R̄; the level is taken at R̄ 24, where Van den Berg et al. (1991) give about 1 kPa from strength 7. */
  multiEnergy: Object.freeze({
    mergedScaledDistances: Object.freeze([.3, .4, .5, .6, 1, 1.5, 2.5, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50, 70, 90]),
    mergedOverpressures: Object.freeze([12.8, 5.35, 3.31, 1.92, .62, .298, .136, .101, .0721, .0536, .0366, .0243, .0151, .0111, .00699, .00497, .00381, .00252, .00193]),
    farFieldShares: Object.freeze([.76, .75, .71, .66, .61]),
    kneeExponent: 6,
    referenceScaledDistance: 24
  }),
  /** Class C, fitted to gas explosion recordings (Doc/reference/audio E1–E12): the roar grows over a quarter of the burn, holds to its end, then dies away; deflagrations roar low, strong explosions flat in octaves; its frequencies fall as the cloud's radius grows, the spectra as fitted for a 150 m³ cloud. */
  roar: Object.freeze({
    riseShare: .25,
    referenceMetres: 4.15,
    spectrumHz: BLAST.roar.spectrumHz,
    deflagrationDensity: Object.freeze([1.3e-3, 2.3e-3, 5.3e-4, 1.7e-4, 2.4e-7, 4e-9]),
    detonationDensity: Object.freeze([1 / 40, 1 / 141, 1 / 500, 1 / 2000, .4 / 8000, 1e-3 / 16000])
  }),
  fuels: Object.freeze({
    methane: Object.freeze({ label: 'Methane', megajoulesPerCubicMetre: 3.22, burningMetresPerSecond: .40 }),
    propane: Object.freeze({ label: 'Propane', megajoulesPerCubicMetre: 3.48, burningMetresPerSecond: .45 }),
    gasoline: Object.freeze({ label: 'Gasoline vapour', megajoulesPerCubicMetre: 3.53, burningMetresPerSecond: .40 }),
    ethylene: Object.freeze({ label: 'Ethylene', megajoulesPerCubicMetre: 3.66, burningMetresPerSecond: .66 }),
    hydrogen: Object.freeze({ label: 'Hydrogen', megajoulesPerCubicMetre: 3.03, burningMetresPerSecond: 2.4 }),
    propyleneOxide: Object.freeze({ label: 'Propylene oxide', megajoulesPerCubicMetre: 3.77, burningMetresPerSecond: .82 }),
    ethyleneOxide: Object.freeze({ label: 'Ethylene oxide', megajoulesPerCubicMetre: 3.99, burningMetresPerSecond: 1.08 })
  }),
  congestions: Object.freeze({
    open: Object.freeze({ label: 'Open', blockageRatio: .01, obstacleMetres: .3 }),
    sparse: Object.freeze({ label: 'Sparse', blockageRatio: .05, obstacleMetres: .3 }),
    dense: Object.freeze({ label: 'Dense', blockageRatio: .1, obstacleMetres: .3 }),
    pipeRack: Object.freeze({ label: 'Pipe rack', blockageRatio: .2, obstacleMetres: .43 })
  }),
  confinements: Object.freeze({
    open: Object.freeze({ label: 'Open above', coefficient: .84, exponent: 2.75 }),
    planes: Object.freeze({ label: 'Under a roof', coefficient: 3.38, exponent: 2.25 })
  }),
  ignitions: Object.freeze({
    spark: Object.freeze({ label: 'Spark' }),
    charge: Object.freeze({ label: 'Burster charge' })
  })
});

/** Class B: NFPA 68 (2018) eq. 7.2.1a with 7.2.1.1 and λ from 7.2.6.1 for gases and mists, eq. 8.2.1.1 and Table B.1.2.4 for dusts, burning velocities and maximum pressures from Tables D.1(a) and D.2; class C: the empty-room factor on λ fitted to Cooper et al. 1986 Fig. 1 and Harrison & Eyre 1987 Table II, the far-ignition factor and external peak share from Harrison & Eyre Table II, the external source radius from their §3.4, the ring from Cooper Fig. 1, vent and wall strengths, dust burning velocities, smoke gas fitted to Rosberg 2001. Doc/design/architecture-decision-9-vented-explosion.md. */
export const ROOM_EXPLOSION = Object.freeze({
  densityKilogramsPerCubicMetre: 1.2,
  viscosityPascalSeconds: 1.8e-5,
  soundMetresPerSecond: 343,
  dischargeCoefficient: .7,
  heatCapacityRatio: 1.4,
  flameReynolds: 4000,
  flameExponent: .39,
  ventFactor: 1.23,
  ventMetresPerSecond: 2.37e-3,
  gasCoefficient: .0223,
  dustCoefficient: 1e-4,
  dustStatic: 1.54,
  expansionRatio: 7.5,
  emptyTurbulenceShare: .24,
  extinctionShare: .25,
  farIgnitionPressureFactor: 3,
  externalPressureShare: .5,
  externalDilution: 3,
  wallMetres: .25,
  wallOpenSeconds: .03,
  ringSoundShare: 1.45,
  ringPressureShare: .4,
  ringCycles: 5,
  ringFloor: .05,
  materials: Object.freeze({
    naturalGas: Object.freeze({ label: 'Natural gas', burningMetresPerSecond: .40, megajoulesPerCubicMetre: 3.22, maximumBar: 7.1 }),
    propane: Object.freeze({ label: 'Propane', burningMetresPerSecond: .46, megajoulesPerCubicMetre: 3.48, maximumBar: 7.9 }),
    oilMist: Object.freeze({ label: 'Oil mist', burningMetresPerSecond: .46, megajoulesPerCubicMetre: 3.5, maximumBar: 7 }),
    dustSt1: Object.freeze({ label: 'Dust St1', kSt: 150, burningMetresPerSecond: .25, megajoulesPerCubicMetre: 3.5, maximumBar: 10 }),
    dustSt2: Object.freeze({ label: 'Dust St2', kSt: 250, burningMetresPerSecond: .42, megajoulesPerCubicMetre: 3.5, maximumBar: 10 }),
    dustSt3: Object.freeze({ label: 'Dust St3', kSt: 400, burningMetresPerSecond: .67, megajoulesPerCubicMetre: 3.5, maximumBar: 12 }),
    smokeGas: Object.freeze({ label: 'Smoke gas', burningMetresPerSecond: .06, megajoulesPerCubicMetre: 1.5, maximumBar: 3, mixingLimited: true })
  }),
  vents: Object.freeze({
    open: Object.freeze({ label: 'Open', kilopascals: 0, openSeconds: .005 }),
    window: Object.freeze({ label: 'Window', kilopascals: 5, openSeconds: .005 }),
    panel: Object.freeze({ label: 'Light panel', kilopascals: 1.5, openSeconds: .02 }),
    door: Object.freeze({ label: 'Door', kilopascals: 2.5, openSeconds: .03 })
  }),
  interiors: Object.freeze({ empty: Object.freeze({ label: 'Empty' }), furnished: Object.freeze({ label: 'Furnished' }) }),
  ignitions: Object.freeze({ centre: Object.freeze({ label: 'Centre' }), far: Object.freeze({ label: 'Far from vent' }) })
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
  /**
   * A followed rocket after burnout: Carlson's K_S = P √A_e,max / l^¾ l_e^¼ (TP-1122, B) for a body of revolution
   * without lift, fineness 20 and a nose three diameters long, P 0.685 as his example's A_e,1/A_e,max of 0.29 (C).
   */
  coastShapeFactor: .049,
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
    volcanoHeightMetres: 6000,
    gasCloudRange: Object.freeze([10, 1e5]),
    roomRange: Object.freeze([1, 1e5]),
    ventRange: Object.freeze([.05, 500])
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
