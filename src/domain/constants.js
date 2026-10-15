export const APP_VERSION = '0.74.0';
export const MODEL_VERSION = '33.3.0';

export const SAMPLE_RATE_HZ = 48000;

export const GAMMA_AIR = 1.4;
export const GAS_CONSTANT_AIR_J_PER_KG_KELVIN = 287.05;
export const KELVIN_OFFSET = 273.15;

export const ISA_LAPSE_RATE_KELVIN_PER_METRE = .0065;
export const STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED = 9.80665;

export const REFERENCE_SOUND_PRESSURE_PA = 20e-6;
export const TNT_JOULES_PER_KILOGRAM = 4.184e6;

export const AIR = Object.freeze({
  /** Class C: within 1.5 % of the exact shadow distance for sources up to 12 km and Γ 6.5–12 K/km. */
  profileFitHeightMetres: 3000
});

export const GROUND = Object.freeze({
  /** Class B: mean of each FHWA TNM ground-type range (Embleton, Piercy & Daigle 1983), kPa·s/m². */
  flowResistivity: Object.freeze({
    snow: 20,
    forestFloor: 50,
    grass: 212.5,
    soil: 278,
    stonyGround: 550
  }),
  /** Class C. */
  roughnessMetres: .05,
  scatterArrivals: 12,
  scatterSeconds: .002,
  /** Class B: ISO 9613-2:1996 Table A.1, dense foliage, 20–200 m. */
  foliageBandsHz: Object.freeze([63, 125, 250, 500, 1000, 2000, 4000, 8000]),
  foliageDecibelsPerMetre: Object.freeze([.02, .03, .04, .05, .06, .08, .09, .12]),
  maximumFoliageMetres: 200,
  /** Class C: 0.006·f^(1/3) dB/m fits the table within 0.006 dB/m (Hoover's frequency law). */
  foliageDecibelsPerCubeRootHertz: .006,
  foliageCutoffHz: 10,
  reverbBandsHz: Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]),
  /** Class B at 1 kHz: snowy forest at Koli, T30 1.3–1.7 s (Shelley, Murphy & Chadwick, DAFx 2013); the rest class C. */
  forest: Object.freeze({
    seconds: Object.freeze([.2, .3, .5, .8, 1.15, 1.5, 1.3, 1, .7, .5]),
    energyShare: .1,
    buildSeconds: .005
  }),
  /** Class C, fitted to Doc/reference/audio sonic1–3 and meteor1. */
  surroundings: Object.freeze({
    seconds: Object.freeze([7, 7, 6, 4.5, 3, 2, 1.5, 1, .7, .5]),
    energyShare: .04,
    buildSeconds: .15
  }),
  terrain: Object.freeze({
    maximumTileRequests: 36,
    maximumPlaceNames: 400,
    patchCells: 128,
    minimumHeightStepMetres: .001,
    echoMarginShare: .25,
    echoMarginMetres: 1000,
    maximumPatches: 64,
    maximumCellMetres: 2000,
    coverageDelayMilliseconds: 800,
    placeNamesLimitSeconds: 30,
    loadLimitSeconds: 60,
    placeSearchLimitSeconds: 15,
    /** Nominatim's usage policy allows one search a second. */
    searchIntervalMilliseconds: 1000
  })
});

export const PROPAGATION = Object.freeze({
  /** Class C. */
  ridge: Object.freeze({
    spanCells: 1,
    maximumRadiusMetres: 5000,
    fadeKR: Object.freeze([1, 10])
  }),
  /** Class C. */
  causticLimitDb: 10,
  /** Class C. */
  maximumBounces: 6,
  shadowRegularizationHz: 5,
  /** Measured at most 3.14, snow to stony ground, 10 Hz–20 kHz. */
  softCreepLag: 3.5,
  /** Class C: the steady-shock 1/Δp law, constant to verify against Pierce & Kang 1990 and Blackstock. */
  shockRisePascalSeconds: .005,
  /** Class B criterion a = sin ψ/√(2βε) (Baskar, Coulouvrat & Marchiano 2007); the blend is class C. */
  mergedParameter: 1,
  linearParameter: 2,
  /** Class C. */
  shockDurationRatio: 10,
  oldAgeDurationRatio: 2,
  /** Class C. */
  mergedFrontFactor: 2,
  /** Class C. */
  endImageSeconds: .02,
  /** Class C. */
  echoGridSide: 150,
  echoCellSeconds: .02,
  /** Class C. */
  scatterBinSeconds: .01,
  azimuthSectors: 8,
  elevationSectors: 3,
  scatterArrivals: 12,
  /** Class C. */
  sharedClassesPerOctave: 1,
  sharedVariants: 2,
  exclusionSpacings: 1.5,
  maximumFocusing: 10
});

export const THUNDER = Object.freeze({
  maximumSegmentsPerEmitter: 100000,
  stormSegmentBudget: 600000,
  minimumCloudDepthMetres: 100,
  /** Class B: ReVelle's weak-shock theory (1974, 1976), from x = r/R₀ = 10. */
  weakShock: Object.freeze({ startRadii: 10, periodGrowth: .562, periodExponent: .25, extraDecayExponent: -.25 }),
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
  burstShare: .15,
  starMetresPerSecond: 40,
  starKilogramsPerSquareMetre: 50,
  crackleDelaySeconds: .5,
  crackleSeconds: 1.5,
  starStepSeconds: .02
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
  /** Class C. */
  approachHeights: 2,
  approachMetres: 20000,
  /** Class C, not fitted. */
  turbulentFront: Object.freeze({
    arrivals: 24,
    frontShare: .5,
    referenceTurbulence: 1e-6,
    riseRatio: 10,
    longestRises: 8
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

/** Class B: acoustic reflex (verify against Borg 1976), Stevens' exponent, Zwicker & Fastl integration; class C as a playback mapping. */
export const EAR = Object.freeze({
  referencePressurePa: REFERENCE_SOUND_PRESSURE_PA,
  envelopeSeconds: .01,
  reflexThresholdDb: 85,
  latencyNearThresholdSeconds: .15,
  latencyAtHighLevelSeconds: .03,
  latencyRangeDb: 30,
  attenuationPerDb: .75,
  maximumAttenuationDb: 20,
  onsetSeconds: .05,
  releaseSeconds: .5,
  adaptationHalfLifeSeconds: 3,
  shelfHz: 1000,
  loudnessExponent: .6,
  loudnessMeanSquareSeconds: .025,
  loudnessLevelSeconds: .05,
  loudnessFloorDb: -60,
  loudnessMaximumBoostDb: 40,
  /** Class C. */
  onsetCapSlewDbPerSecond: 2000
});

export const PREVIEW = Object.freeze({
  sourceMerge: 4,
  echoCellScale: 2,
  highestHz: 2000
});

export const RENDER_COST = Object.freeze({
  forestShare: .1,
  sharedSaving: .32,
  fixedShare: .3,
  referenceHz: 4000,
  binExponent: .8,
  cellExponent: -.74,
  arrivalShare: .5,
  scatterShare: .68
});

export const RENDER = Object.freeze({
  maximumSeconds: 400,
  maximumSources: 1500000,
  maximumEmitters: 8,
  maximumReceivers: 8,
  sceneExtentMetres: 300000,
  maximumHeightMetres: 120000,
  sourceCopiesBudget: 1000000,
  progressWeights: Object.freeze([1, 22, 4.5, 1, 1]),
  stallSeconds: 60,
  maximumWorkers: 8,
  autoDelayMilliseconds: 200,
  peakTarget: 10 ** (-3 / 20),
  binauralHeadroom: 10 ** (-3 / 20),
  scheduleLeadSeconds: .08,
  fadeSeconds: .05,
  breakUpDecibels: 20,
  shortenedLeadSeconds: .5,
  silenceShare: 1e-4
});

export const VIEW = Object.freeze({
  box: Object.freeze({
    marginPixels: 36,
    minimumSpanMetres: 100,
    closeSpanMetres: 4,
    padding: .08,
    rotateRadiansPerPixel: .008,
    pitchRange: Object.freeze([.12, 1.45]),
    zoomRange: Object.freeze([.02, 40]),
    zoomPerPixel: .006,
    wheelLinePixels: 16,
    defaultView: Object.freeze({ yaw: .62, pitch: .42, zoom: 1, panU: 0, panV: 0 }),
    clickPixels: 4,
    degenerateArea: .08,
    handleRadius: 5,
    hitRadius: 10,
    microphoneRadius: 5.5,
    arrowheadPixels: 8,
    facingLengthShare: .1,
    outlinePixels: 1.2,
    seamPixels: 1
  }),
  orientationBall: Object.freeze({
    marginPixels: 12,
    scaleSpacePixels: 30,
    scaleGrabPixels: 10,
    handleRadius: 4.5
  }),
  placeMap: Object.freeze({
    minimumZoom: 3,
    maximumZoom: 17,
    zoomPerPixel: .004
  }),
  panels: Object.freeze({
    widthRange: Object.freeze([260, 680]),
    resultsMinimumPixels: 120,
    resultsMaximumShare: .7,
    keyboardStepPixels: 16,
    macroSteps: 1000,
    thumbHalfPixels: 6
  }),
  macros: Object.freeze({
    energyRange: Object.freeze([3e3, 3e6]),
    crackStraightRange: Object.freeze([3, .2]),
    maximumBranches: 24,
    maximumZigzagDegrees: 45,
    fineTortuosity: Object.freeze([4, 28]),
    cloudRange: Object.freeze([200, 18000])
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
  }),
  cone: Object.freeze({
    rings: 16,
    ringPoints: 32,
    lineEvery: 4,
    pieces: 12,
    alpha: .45,
    bodies: 24,
    levels: 12
  }),
  wavefront: Object.freeze({
    spheres: 360,
    groups: 24,
    shadowShare: .35,
    flightFronts: 120,
    topDb: 140,
    floorDb: 60,
    localProfileTolerance: .05,
    rippleAlphas: Object.freeze([.5, .3, .16, .07]),
    rippleSpacingShare: .018,
    terrainSpheres: 80,
    visibleAlpha: 1 / 255
  }),
  map: Object.freeze({
    cachedTiles: 144,
    viewMargin: 1.25,
    minimumSine: .25,
    maximumZoom: 17,
    pixelsAcross: 2048,
    alpha: 1,
    lightLand: .92,
    darkLine: .35,
    waterBlue: 40,
    waterShare: .12
  }),
  terrain: Object.freeze({
    drawCells: 110,
    light: Object.freeze({ x: -1, y: 1, z: 1.6 }),
    fogShare: .6,
    edgeShare: .05,
    contourBands: 12,
    maximumLabels: 60
  }),
  shadowBoundary: Object.freeze({
    points: 600,
    edgeAlpha: .7,
    terrainCells: 48,
    terrainSources: 120,
    planeSamples: 8
  }),
  statusSeconds: 8,
  envelopeSeconds: .01,
  envelopeRangeDb: 40,
  plots: Object.freeze({
    leftPixels: 8,
    rightPixels: 8,
    topPixels: 22,
    bottomPixels: 20,
    dimmed: .4,
    muted: .35,
    overlapping: .6,
    solo: .85
  }),
  arrivalDiagramHz: 100
});
