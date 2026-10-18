export const SAMPLE_RATE_HZ = 48000;

export const GAMMA_AIR = 1.4;

export const GAS_CONSTANT_AIR_J_PER_KG_KELVIN = 287.05;

export const KELVIN_OFFSET = 273.15;

export const ISA_LAPSE_RATE_KELVIN_PER_METRE = .0065;

export const STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED = 9.80665;

export const REFERENCE_SOUND_PRESSURE_PA = 20e-6;

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
  maximumFocusing: 10,
  /** Class C: sub-arrival delays end at this many rise times. */
  longestRises: 8,
  /** Class B: ReVelle's weak-shock theory (1974, 1976), from x = r/R₀ = 10. */
  weakShock: Object.freeze({ startRadii: 10, periodGrowth: .562, periodExponent: .25, extraDecayExponent: -.25 }),
  /**
   * Class C: the slow level fluctuation of a long sound through turbulence, a part shared by all bands and a part
   * of each, fitted to Rumbletect's jet recordings (0.2–2 s fluctuation about 2.3 dB, inter-band correlation
   * 0.5–0.75). Applied to grains only: a pulse is over before it changes.
   */
  scintillation: Object.freeze({
    decibels: 3.5,
    bandShare: .45,
    seconds: .2,
    bandsHz: Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000])
  }),
  /** A grain: a sine-windowed frame of this many samples at half overlap. */
  grainSamples: 4096
});

/** Class B: acoustic reflex (verify against Borg 1976), Stevens' exponent, Zwicker & Fastl integration; class C as a playback mapping. */
export const TRAJECTORY = Object.freeze({
  stepSeconds: .05,
  maximumSteps: 12000,
  stoppedMetresPerSecond: 1,
  /** Class C: a supersonic path starts this far back, so that its first booms are heard whole. */
  approachHeights: 2,
  approachMetres: 20000
});

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
  /** Sound arriving after `maximumSeconds` is left out, the kept end faded over this long. */
  truncationFadeSeconds: .05,
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
  audioResumeSeconds: 8,
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
    /** A continuous source's lit ring waits at its shadow edge this many front spacings, so the lit edge of nearly concentric fronts never steps back. */
    shadowHoldSpacings: 1.5,
    terrainSpheres: 80,
    visibleAlpha: 1 / 255
  }),
  map: Object.freeze({
    cachedTiles: 320,
    /** Tiles requested for one view of the map, and the wait before a failed tile is asked for once more. */
    maximumTiles: 120,
    retryMilliseconds: 1500,
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
