/**
 * Physical constants, and every tuning value and limit of the model and the view, in one place.
 * Coordinates are metres in a right-handed frame: x east, y north, z up, with the ground plane at z = 0.
 *
 * Sections: AIR, GROUND, PROPAGATION, THUNDER, BLAST, FLIGHT, METEOR, EAR, RENDER, VIEW. Each value
 * carries its unit in its name and its reliability class: A from first principles, B from
 * literature, C a heuristic or synthetic choice.
 *
 * Elsewhere: the parameters a scene sets, with their defaults, ranges, and classes, are in
 * `scene.js` (PARAMETERS and the default emitters). Identifiers, numerical-method constants
 * (iterations, tolerances, quadrature), the coefficients of published formulas (ISO 9613-1,
 * Delany–Bazley, Kinney & Graham, Carlson, ReVelle), and file formats stay with their code.
 *
 * This module imports nothing, so every module, the views included, may import it.
 */

export const MODEL_VERSION = '28.0.0';

export const SAMPLE_RATE_HZ = 48000;

export const GAMMA_AIR = 1.4;
export const GAS_CONSTANT_AIR_J_PER_KG_KELVIN = 287.05;
export const KELVIN_OFFSET = 273.15;

/** ISA troposphere lapse rate (ISO 2533), the default temperature gradient; and standard gravity. */
export const ISA_LAPSE_RATE_KELVIN_PER_METRE = .0065;
export const STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED = 9.80665;

/** Reference sound pressure of decibels SPL. */
export const REFERENCE_SOUND_PRESSURE_PA = 20e-6;
/** Energy of a kilogram of TNT, by convention. */
export const TNT_JOULES_PER_KILOGRAM = 4.184e6;

export const AIR = Object.freeze({
  /**
   * The linear sound-speed profile of a path is fitted to the layered air up to this height for
   * T(z) = T₀ − Γz (class C). That height keeps the shadow distance within 1.5 % of the exact
   * profile's for sources up to 12 km and Γ from 6.5 to 12 K/km; with the ISA gradient the speed
   * departs by at most 1.8 m/s up to 10 km. A ground layer replaces it with its own depth.
   */
  profileFitHeightMetres: 3000
});

export const GROUND = Object.freeze({
  /**
   * Effective flow resistivity of natural ground in kPa·s/m² (cgs rayls), class B: the mean of each
   * range in FHWA TNM ground types (Embleton, Piercy & Daigle 1983). Adopted from Echotect
   * `src/materials.js` at commit cb712ef6. Rigid ground and water reflect without loss.
   */
  flowResistivity: Object.freeze({
    snow: 20,
    forestFloor: 50,
    grass: 212.5,
    soil: 278,
    stonyGround: 550
  }),
  /**
   * A ground reflection is only partly coherent with the direct sound: the ground's roughness
   * (Rayleigh, σ² = (2k·h·sin ψ)², h = roughnessMetres on natural ground) and the turbulence between
   * the paths scatter a share 1 − e^(−σ²) of its energy, which returns as `scatterArrivals` seeded
   * sub-arrivals of random sign over a few milliseconds (mean `scatterSeconds`) rather than as one
   * sharp copy (class C for the height and the spread). Without it every sharp pulse and its
   * reflection sounded as a pitch at the inverse of their delay (measured: 160–270 Hz, correlation
   * 0.29–0.46 at a microphone 1.7 m up).
   */
  roughnessMetres: .05,
  scatterArrivals: 12,
  scatterSeconds: .002,
  /**
   * Foliage attenuation, class B: ISO 9613-2:1996, Table A.1, attenuation through dense foliage per
   * metre of path, octave bands 63 Hz–8 kHz, for 20–200 m of foliage; beyond 200 m the 200 m value
   * holds. ISO 9613-2 excludes blast waves, which holds here once the blast is linear.
   */
  foliageBandsHz: Object.freeze([63, 125, 250, 500, 1000, 2000, 4000, 8000]),
  foliageDecibelsPerMetre: Object.freeze([.02, .03, .04, .05, .06, .08, .09, .12]),
  maximumFoliageMetres: 200,
  /**
   * The table follows 0.006·f^(1/3) dB/m within 0.006 dB/m in every band, the frequency law of
   * Hoover's forest formula, 0.01·f^(1/3) dB/m. As s·(s + ω_c)^(−2/3) it has the phase lag that keeps
   * it causal (as the creeping wave); well below the cutoff it becomes a delay (class C).
   */
  foliageDecibelsPerCubeRootHertz: .006,
  foliageCutoffHz: 10,
  /** Octave bands of the forest's and the surroundings' tails. */
  reverbBandsHz: Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]),
  /**
   * Reverberation of the forest around the receiver. Class B at 1 kHz: T30 of 1.3–1.7 s in snowy
   * forest at Koli National Park (Shelley, Murphy & Chadwick, DAFx 2013), where most of the
   * reverberant energy lies at 1 kHz and the low bands are dry. The other bands' times are shaped
   * around it (class C). The energy share is the tail's against the sound that excites it, at 1 kHz;
   * other bands scale with their reverberation time (class C: the Koli clarity C50 was high, so the
   * tail is well below the direct sound near the source). It builds up from the nearest trunks over a
   * few milliseconds (class C).
   */
  forest: Object.freeze({
    seconds: Object.freeze([.2, .3, .5, .8, 1.15, 1.5, 1.3, 1, .7, .5]),
    energyShare: .1,
    buildSeconds: .005
  }),
  /**
   * The rumble of the surroundings over level ground: what the distant land, its edges of forest,
   * buildings, and hills return of a loud sound. Class C, fitted to recorded sonic booms and the
   * Chelyabinsk fireball (Doc/reference/audio sonic1–3, meteor1): a tail at 15–25 dB under the
   * sound, falling 8–10 dB per second, mostly below 250 Hz. It builds up over `buildSeconds`, as the
   * nearest of it is some way off.
   */
  surroundings: Object.freeze({
    seconds: Object.freeze([7, 7, 6, 4.5, 3, 2, 1.5, 1, .7, .5]),
    energyShare: .04,
    buildSeconds: .15
  }),
  /**
   * Terrain captures: the heightfield's longest side, so that a capture stays light to store and
   * trace; the elevation tiles fetched at most; and the place names kept with a terrain.
   */
  terrain: Object.freeze({
    maximumGridCells: 600,
    maximumTileRequests: 36,
    maximumPlaceNames: 400,
    /**
     * Loaded terrain is widened when the scene reaches within edgeMargin times its reach plus
     * marginMetres of its edge, coverageDelayMilliseconds after the last change; a new capture spans
     * loadMargin times what the scene needs.
     */
    edgeMargin: 1.1,
    marginMetres: 300,
    coverageDelayMilliseconds: 800,
    loadMargin: 1.25,
    /** Seconds a network request for place names or a place search may take before it is given up. */
    placeNamesLimitSeconds: 30,
    placeSearchLimitSeconds: 15,
    /** Nominatim's usage policy allows one search a second. */
    searchIntervalMilliseconds: 1000
  })
});

export const PROPAGATION = Object.freeze({
  /** Greatest focusing gain of a reflected ray tube near a caustic, in decibels (class C). */
  causticLimitDb: 10,
  /** Most ground contacts of a ray in air whose speed grows with height (class C: more lose too much to the ground to matter). */
  maximumBounces: 6,
  /**
   * Below this frequency the creeping response is regularized so that its tail decays within a
   * frame, and the soft-ground transition is kept at or above it.
   */
  shadowRegularizationHz: 5,
  /** The largest lag of the creeping mode over soft ground relative to rigid ground, measured 3.14 (snow to stony ground, 10 Hz–20 kHz). */
  softCreepLag: 3.5,
  /**
   * A shock keeps a steep front while nonlinear steepening outpaces absorption: its front rises no
   * slower than the steady rise time τ = shockRisePascalSeconds / Δp, whatever the linear absorption
   * along the path (class C; the 1/Δp law of a steady shock, with a constant to verify against
   * Pierce & Kang 1990 and Blackstock, Fundamentals of Physical Acoustics: 8 µs at 600 Pa, 5 ms at
   * 1 Pa).
   */
  shockRisePascalSeconds: .005,
  /**
   * A shock meeting the ground at grazing angle ψ reflects nonlinearly when a = sin ψ/√(2βε) is
   * small, ε = Δp/(γp₀): the incident and reflected fronts merge into one (von Neumann reflection,
   * regular above a ≈ √2; Baskar, Coulouvrat & Marchiano 2007, JFM; class B for the criterion).
   * Below `mergedParameter` the ground reflects the pulse as rigid ground would, above
   * `linearParameter` with its impedance, smoothly between (class C).
   */
  mergedParameter: 1,
  linearParameter: 2,
  /**
   * Both hold only while the pulse is still a shock: when its steady rise time is short against its
   * duration T. At T/τ ≥ shockDurationRatio it acts fully, at T/τ ≤ oldAgeDurationRatio not at all,
   * where absorption has the last word and the pulse reflects linearly (class C). A blast's aging
   * stops at oldAgeDurationRatio too.
   */
  shockDurationRatio: 10,
  oldAgeDurationRatio: 2,
  /** A blast within its linearization radius of the ground spreads as a merged hemispherical front of this many times the pressure (class C, as the merged reflection). */
  mergedFrontFactor: 2,
  /**
   * An echo leaves a source near the ground and reaches a receiver near it together with its image
   * in the ground there. Ends whose image lags more than this arrive as echoes of their own, which
   * are not traced (class C).
   */
  endImageSeconds: .02,
  /** Terrain echoes (class C): the echo grid's longest side; finer terrain is sampled down to it. */
  echoGridSide: 150,
  /** Sources whose emissions lie this far apart fall in different echo cells, so strokes stay apart. */
  echoCellSeconds: .02,
  /**
   * Scattered patches merge by arrival in bins of this width and by direction in these sectors, and
   * a merged echo is rendered as `scatterArrivals` seeded sub-arrivals of random sign spread over its
   * patches' arrival times, which keeps its energy at every frequency on average (class C; a point
   * copy sounds as a click).
   */
  scatterBinSeconds: .01,
  azimuthSectors: 8,
  elevationSectors: 3,
  scatterArrivals: 12,
  /** Ground within this many echo cells of a receiver, or of a source near the ground, is the ground reflection's. */
  exclusionSpacings: 1.5,
  /** Energy gain of a focusing concave reflection at most, where the caustic would diverge: 10 dB. */
  maximumFocusing: 10
});

export const THUNDER = Object.freeze({
  /** Segments of one flash's main channel and branches; a storm shares stormSegmentBudget among its branches. */
  maximumSegmentsPerEmitter: 100000,
  stormSegmentBudget: 600000,
  /** Minimum depth of a storm's cloud layer. */
  minimumCloudDepthMetres: 100,
  /**
   * Class B: ReVelle's cylindrical weak-shock theory (ReVelle 1974, 1976; used for thunder and
   * meteors). The fundamental period at x = r/R₀ = 10 is τ₀ = k·R₀/c with k ≈ 2.81, and in the weakly
   * nonlinear regime it grows as τ(x) = 0.562·τ₀·x^(1/4) while the overpressure falls as x^(−3/4),
   * that is x^(−1/4) faster than linear cylindrical spreading.
   */
  weakShock: Object.freeze({ startRadii: 10, periodGrowth: .562, periodExponent: .25, extraDecayExponent: -.25 }),
  /** Channel shape, class C. */
  channel: Object.freeze({
    /** Branches leave their parent between these shares of its length. */
    branchJunctionRange: Object.freeze([.1, .95]),
    /** Ground-flash branches descend at this angle from straight down, in degrees. */
    groundBranchAngleDegrees: Object.freeze([15, 65]),
    /** A sub-branch leaves its parent's direction by this angle, in degrees. */
    subBranchAngleDegrees: Object.freeze([20, 60]),
    /** Cloud-flash branches stay within this elevation of the horizontal, in degrees. */
    cloudBranchElevationDegrees: 20,
    /**
     * A ground flash's in-cloud channels. Mapped ground flashes show long, near-horizontal channels
     * inside the cloud (VHF lightning mapping; no typical length verified yet). Two leave the top in
     * roughly opposite directions, within this elevation, each reaching this share of the nominal
     * length or more, and their energy per metre falls to e^(−inCloudTaper) at the far end.
     */
    inCloudChannels: 2,
    inCloudElevationDegrees: 10,
    inCloudSpreadDegrees: 50,
    inCloudLengthShare: Object.freeze([.6, 1]),
    inCloudTaper: 4,
    /** A branch reaches between this share and all of its nominal length. */
    branchLengthMinimumShare: .3,
    /** Each branching level has this share of the previous level's count and length. */
    subBranchCountShare: .5,
    subBranchLengthShare: .45,
    /** A new ground termination leaves the channel between these shares of its height. */
    terminationJunctionRange: Object.freeze([.2, .7]),
    /** A new ground point lies this far from the junction per metre of junction height. */
    terminationReachRange: Object.freeze([.2, .8])
  }),
  /**
   * Flash statistics of a generated storm. Values marked B are typical literature figures that still
   * need verification against primary sources; values marked C are synthetic choices.
   */
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
  /**
   * Explosives, class B: packing density and velocity of detonation from Rigby & Gitterman,
   * "Secondary shock delay measurements from explosive trials", MABS 24, 2016, Table 1 (ANFO the
   * middle of its ranges). They time the secondary shock (`explosives.js`).
   */
  explosives: Object.freeze({
    tnt: Object.freeze({ label: 'TNT', densityKgPerCubicMetre: 1630, detonationMetresPerSecond: 6930 }),
    pe4: Object.freeze({ label: 'PE4 / C4', densityKgPerCubicMetre: 1601, detonationMetresPerSecond: 8193 }),
    compB: Object.freeze({ label: 'Composition B', densityKgPerCubicMetre: 1717, detonationMetresPerSecond: 7980 }),
    petn: Object.freeze({ label: 'PETN', densityKgPerCubicMetre: 1770, detonationMetresPerSecond: 8300 }),
    anfo: Object.freeze({ label: 'ANFO', densityKgPerCubicMetre: 825, detonationMetresPerSecond: 4325 })
  }),
  /**
   * Class B/C: the secondary shock loads like a smaller charge of 3.2–4.9 % of the mass (empirical
   * model fitted to 58 tests with PE4, PE8, and PE10, Shock Waves 2024, doi 10.1007/s00193-024-01208-y;
   * from its abstract). Boomtect radiates it as a Friedlander pulse of that charge.
   */
  secondaryMassShare: .04,
  /**
   * The longest positive phase of a blast high in the air (class C, a render limit): a burst of a
   * meteoroid over a few metres would last tens of seconds, all of it infrasound, and its frames
   * would exceed the longest render. Its front, which is what is heard, keeps its pressure.
   */
  maximumHighBlastSeconds: 2,
  /**
   * The roar after the shock, class C, fitted to recordings of improvised charges set off on an
   * open grass field (FBI video, Doc/reference/audio). Measured 0.1–0.3 s after the shock (mean of
   * four, band energies against the window's total): 20–80 Hz −11 dB, 80–250 Hz −4 dB, 250–1000 Hz
   * −4 dB, 1–4 kHz −9 dB, 4–16 kHz −26 dB, here as power spectral density at the band centres,
   * log-interpolated, falling as f² below the first; the 8 kHz density is set so that the 4–16 kHz
   * share comes out as measured (−26.6 dB). It rises over a few milliseconds after the shock and
   * falls by `durationDecibels` over its duration; its level is the largest RMS over `windowSeconds`.
   */
  roar: Object.freeze({
    spectrumHz: Object.freeze([40, 141, 500, 2000, 8000, 16000]),
    spectrumDensity: Object.freeze([1.3e-3, 2.3e-3, 5.3e-4, 4.2e-5, 6e-8, 1e-9]),
    riseSeconds: .01,
    durationDecibels: 30,
    windowSeconds: .05
  }),
  /** Jitter of a barrage's salvo time as a share of the interval between salvos (class C). */
  salvoJitter: .15
});

export const FLIGHT = Object.freeze({
  /**
   * Bodies from Carlson's sample problems (NASA TP-1122): length l and shape factor K_S (which
   * replaces Whitham's F-function), class B. The rocket's boom is dominated by its exhaust plume
   * (Apollo launch vehicle at M 4.08 and 36 km; K_S = 0.68 reproduces both his 184 Pa and 3.90 s).
   */
  bodies: Object.freeze({
    reconnaissance: Object.freeze({ label: 'Reconnaissance aircraft', lengthMetres: 32.7, shapeFactor: .087 }),
    bomber: Object.freeze({ label: 'Medium bomber', lengthMetres: 30, shapeFactor: .088 }),
    rocket: Object.freeze({ label: 'Launch vehicle', lengthMetres: 104.5, shapeFactor: .68 }),
    custom: Object.freeze({ label: 'Custom', lengthMetres: null, shapeFactor: null })
  }),
  /** The growth of a focused boom over the steady one, at most (class C, where ray theory fails at a caustic). */
  focusLimit: 5,
  /**
   * A body supersonic at its start has been flying before it: the path the renderer searches begins
   * approachHeights·h/√(M² − 1) plus approachMetres before the start, straight and at the start's
   * speed (class C).
   */
  approachHeights: 2,
  approachMetres: 20000,
  /**
   * A boom crosses the turbulent air near the ground, which bends its front into spikes and rounds
   * (peaked and rounded booms). Its front is rendered as the direct front plus a scattered part of
   * `arrivals` seeded sub-arrivals of zero sum, delayed exponentially by the rise time on average, so
   * the N-wave keeps its shape and area while its front gains spikes (class C). The scattered part's
   * RMS against the front is `frontShare` at `referenceTurbulence` and grows with the square root of
   * the turbulence (class C, not fitted: it adds the spikes and 1–3 dB at 250–1000 Hz). Each part
   * rises in the rise time divided by `riseRatio`, about a steady shock's rise at tens of pascals; the
   * 1–4 kHz band follows from it: 18 dB under 80–250 Hz, against 14–27 dB in recorded booms
   * (Doc/reference/audio/sonic1–3). The latest sub-arrival, of this front and of a ground
   * reflection's scattered part, comes `longestRises` of their mean delays late.
   */
  turbulentFront: Object.freeze({
    arrivals: 24,
    frontShare: .5,
    referenceTurbulence: 1e-6,
    riseRatio: 10,
    longestRises: 8
  })
});

export const METEOR = Object.freeze({
  /** ReVelle's period coefficient k in τ₀ = k·R₀/c (class B). */
  periodCoefficient: 2.81,
  /** The boom falls as a weak cylindrical shock up to this many blast radii, as a linear wave beyond (class B). */
  limitRadii: 1e4,
  /**
   * A meteoroid breaks up in generations: each fragment splits in two, and generation k breaks where
   * the ram pressure ρv² reaches the strength times breakupPressureRatio^k, the smaller fragments
   * being stronger, each fragment at its own pressure spread lognormally by breakupPressureSpread
   * (class C; Popova et al. 2011 find several breakups per fireball at rising pressures, Chelyabinsk
   * a cascade of them). Each generation releases the breakup share of the kinetic energy.
   */
  breakupPressureRatio: 2,
  breakupPressureSpread: .5
});

/**
 * An optional listener model applied to what plays (`ear.js`): the middle-ear acoustic reflex and
 * loudness compression.
 *
 * Acoustic reflex (class B; Wikipedia "Acoustic reflex" and the sources it cites, verify against
 * Borg 1976 or Margolis & Popelka): threshold about 70–100 dB SPL; contraction latency about
 * 150 ms near threshold and 25–35 ms at high levels; about 15 dB less transmission 20 dB above
 * threshold, mostly at low frequencies; maximum tension after about 100 ms; tension halves after a
 * few seconds of sustained sound.
 *
 * Loudness (class B for the exponent, Stevens' power law: loudness ∝ intensity^0.3, that is
 * pressure^0.6; class C as a playback mapping). The level follows the ear's temporal integration
 * of loudness, of the order of 100 ms (class B, Zwicker & Fastl, Psychoacoustics; class C for the
 * two stages): a mean square over 25 ms, smoothed in decibels over 50 ms.
 */
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
  loudnessMaximumBoostDb: 40
});

export const RENDER = Object.freeze({
  /** The longest span of arrivals a render holds. */
  maximumSeconds: 400,
  maximumSources: 1500000,
  maximumEmitters: 8,
  maximumReceivers: 8,
  /** Flights cover tens of kilometres, and meteors come from the upper atmosphere. */
  sceneExtentMetres: 150000,
  maximumHeightMetres: 120000,
  /**
   * Every worker holds the whole scene, so very large scenes use fewer of them to bound memory: a
   * worker peaks at about 0.8 kB per point source while it prepares the sources (102 MB for 130 912
   * sources, measured on heap and buffers), and the budget keeps all workers together near 800 MB.
   */
  sourceCopiesBudget: 1000000,
  /** A render whose workers have sent nothing for this long has failed, for example out of memory. */
  stallSeconds: 60,
  /** Render workers at most, one fewer than the processor's threads. */
  maximumWorkers: 8,
  /** Auto renders this long after the last change. */
  autoDelayMilliseconds: 200,
  /** Peak normalization leaves 3 dB of headroom for resampling and inter-sample peaks. */
  peakTarget: 10 ** (-3 / 20),
  /** Binaural decoding can raise the peak above the pressure's; it gets 3 dB more room. */
  binauralHeadroom: 10 ** (-3 / 20),
  /** Seconds between pressing Play and the start of the timeline, so scheduling never lands in the past. */
  scheduleLeadSeconds: .08,
  /** Playback fades in when it starts and out when it stops over this time, so a cut into a sound does not click. */
  fadeSeconds: .05,
  /** Without the real delay, the first sound starts this long after playback begins. */
  shortenedLeadSeconds: .5,
  /** Below this share of the peak a sample is silence, so playback without the real delay skips it. */
  silenceShare: 1e-4
});

export const VIEW = Object.freeze({
  /**
   * The box: its margin on screen in pixels; the smallest span it shows and its padding as a share of
   * the scene; turning and zooming per pixel of drag, pinch, or wheel (a mouse wheel notch is about
   * 100 pixels, a wheel that scrolls by lines wheelLinePixels a line) and their ranges; the view it starts from (turn, zoom over the fit, and pan in units
   * of the box's half-extent on screen); a press that moves less than clickPixels is a click; below
   * degenerateArea of screen a plane is seen edge-on and offers no handles. Then the sizes of handles,
   * microphones, and arrows in pixels, and the facing arrow's length as a share of the box; outlines
   * reach outlinePixels outside their shape, and a seam of seamPixels is cut along every edge.
   */
  box: Object.freeze({
    marginPixels: 36,
    minimumSpanMetres: 100,
    padding: .08,
    rotateRadiansPerPixel: .008,
    pitchRange: Object.freeze([.12, 1.45]),
    zoomRange: Object.freeze([.2, 40]),
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
  /**
   * The orientation sphere: its margin, the width beside it for the elevation scale and how far left
   * of the scale a press still grabs it, and its handles' radius, in pixels.
   */
  orientationBall: Object.freeze({
    marginPixels: 12,
    scaleSpacePixels: 30,
    scaleGrabPixels: 10,
    handleRadius: 4.5
  }),
  /** The map for choosing a place: its zoom range and zoom per pixel of drag, pinch, or wheel. */
  placeMap: Object.freeze({
    minimumZoom: 3,
    maximumZoom: 17,
    zoomPerPixel: .004
  }),
  /**
   * Panels: the side panel's width range and the results' smallest height in pixels and largest
   * share of the window, moved by keyboardStepPixels per key; a macro slider's steps, and half its
   * thumb's width, as the filled track runs between thumb centres.
   */
  panels: Object.freeze({
    widthRange: Object.freeze([260, 680]),
    resultsMinimumPixels: 120,
    resultsMaximumShare: .7,
    keyboardStepPixels: 16,
    macroSteps: 1000,
    thumbHalfPixels: 6
  }),
  /**
   * What the macros span: a flash's energy per metre (J/m, log), its crack's straight length (m, log,
   * from coarse to fine), its branches and zigzag at most, the fine tortuosity the zigzag sets
   * (degrees), and a storm's cloud layer (m, log).
   */
  macros: Object.freeze({
    energyRange: Object.freeze([3e3, 3e6]),
    crackStraightRange: Object.freeze([3, .2]),
    maximumBranches: 24,
    maximumZigzagDegrees: 45,
    fineTortuosity: Object.freeze([4, 28]),
    cloudRange: Object.freeze([200, 18000])
  }),
  /**
   * Figurative flash: every stroke runs its route in traverseSeconds, then fades over fadeSeconds,
   * and leaves the screen visibleSeconds after it has run; its light flickers between seeded levels
   * flickerSeconds apart. Physically a return stroke takes microseconds.
   */
  flash: Object.freeze({
    traverseSeconds: .12,
    fadeSeconds: .2,
    visibleSeconds: 1.2,
    flickerSeconds: .025
  }),
  /** While the sound plays without the real delay, a point glows from its arrival for this long. */
  soundGlowSeconds: .25,
  /**
   * A storm's cloud, representational only: soft puffs placed by its seed in the cloud layer, a dark,
   * flat base and a paler top that spreads into an anvil. A flash lights the cloud around its top
   * for as long as its channel glows, with `flashBlobs` glows that stray `blobScatter` of the cloud's
   * depth from its channel, each `flashReach` of the depth in radius.
   */
  cloud: Object.freeze({
    puffs: 240,
    puffAlpha: .34,
    anvilSpread: .45,
    flashAlpha: 1.2,
    flashReach: .32,
    flashBlobs: 6,
    blobScatter: .25
  }),
  /**
   * A Mach cone is drawn through the fronts from `rings` past points of the body's path, with
   * `ringPoints` points around each; every `lineEvery` of a ring's points leads to the next ring, in
   * `pieces` pieces kept above the ground.
   */
  cone: Object.freeze({
    rings: 16,
    ringPoints: 32,
    lineEvery: 4,
    pieces: 12,
    alpha: .45
  }),
  /**
   * Wavefronts: source points drawn at most, and points along a flight path. A front is drawn as
   * strong as its sound where it has spread to: the pressure after spreading as 1/r and air
   * absorption at frequencyHz, fully at topDb and gone at floorDb (display only; model pascals, not
   * calibrated). Up high in layered air a front is drawn in homogeneous air at the speed there once
   * the linear profile strays more than localProfileTolerance from it. A front crossing a face is a
   * ripple: the front and fading rings behind it, spaced by a share of the box. Over terrain, where a
   * front meets the ground is solved per direction, so fewer fronts are drawn.
   */
  wavefront: Object.freeze({
    spheres: 360,
    flightFronts: 120,
    frequencyHz: 1000,
    topDb: 140,
    floorDb: 60,
    localProfileTolerance: .05,
    rippleAlphas: Object.freeze([.5, .3, .16, .07]),
    rippleSpacingShare: .018,
    terrainSpheres: 80
  }),
  /**
   * The map on the floor: the finest zoom (OpenTopoMap serves up to 17) at which about pixelsAcross
   * pixels span the terrain, drawn opaque, its tiles turned into the palette: lightness of open land
   * and of the darkest lines, how much bluer than red water is, and how much it shows.
   */
  map: Object.freeze({
    maximumZoom: 17,
    pixelsAcross: 2048,
    alpha: 1,
    lightLand: .92,
    darkLine: .35,
    waterBlue: 40,
    waterShare: .12
  }),
  /**
   * The terrain is drawn on a grid of at most drawCells a side, lit from the north-west and above;
   * outside the box it fades into the panel over fogShare of the box's width, and the edge of the
   * capture over edgeShare of its own width. Contours stripe it in about contourBands bands, and at
   * most maximumLabels place names are drawn.
   */
  terrain: Object.freeze({
    drawCells: 110,
    light: Object.freeze({ x: -1, y: 1, z: 1.6 }),
    fogShare: .3,
    edgeShare: .05,
    contourBands: 12,
    maximumLabels: 60
  }),
  /**
   * The refraction shadow's boundary on the floor: source points sampled; over terrain a grid of
   * terrainCells a side from terrainSources source points, with planeSamples ground samples for each
   * mean plane, fewer than the render uses.
   */
  shadowBoundary: Object.freeze({
    points: 600,
    edgeAlpha: .7,
    terrainCells: 48,
    terrainSources: 120,
    planeSamples: 8
  }),
  /** Microphone levels in the scene: envelope window, and the range below the loudest microphone's peak. */
  envelopeSeconds: .01,
  envelopeRangeDb: 40,
  /** Plots: margins in pixels, and opacity of microphones other than the solo one, of muted ones, and of the rest, which may overlap. */
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
  /** Frequency at which the arrival diagram weighs a shadow path's creeping loss. */
  arrivalDiagramHz: 100
});
