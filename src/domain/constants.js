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

/** The application's version, as in package.json (a test keeps them equal). */
export const APP_VERSION = '0.72.2';
export const MODEL_VERSION = '33.3.0';

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
   * sharp copy, which sounded as a pitch at the inverse of the delay (class C for the height and the spread).
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
  /** Terrain: the elevation tiles fetched at most at once, and the place names kept with a terrain. */
  terrain: Object.freeze({
    maximumTileRequests: 36,
    maximumPlaceNames: 400,
    /**
     * Terrain is held in square patches of patchCells cells, heights in 16-bit steps above each
     * patch's lowest cell, a step its range over 65 535 and at least minimumHeightStepMetres. A scene holds the patches that cover what
     * its sound can meet: every emitter and microphone, and around them echoMarginShare of the
     * scene's size but at least echoMarginMetres, for the slopes behind them that echo. At most
     * maximumPatches: a larger area takes a cell twice as coarse, as often as needed. The patches
     * follow coverageDelayMilliseconds after the last change.
     */
    patchCells: 128,
    minimumHeightStepMetres: .001,
    echoMarginShare: .25,
    echoMarginMetres: 1000,
    maximumPatches: 64,
    maximumCellMetres: 2000,
    coverageDelayMilliseconds: 800,
    /** Seconds a network request for place names or a place search may take before it is given up. */
    placeNamesLimitSeconds: 30,
    placeSearchLimitSeconds: 15,
    /** Nominatim's usage policy allows one search a second. */
    searchIntervalMilliseconds: 1000
  })
});

export const PROPAGATION = Object.freeze({
  /**
   * A rounded ridge (`diffraction.js`): its radius from the curvature of its crest over
   * ridgeSpanCells of the heightfield either side, at most maximumRadiusMetres (a plateau's
   * corners are Deygout's edges); its rounding's loss fades in as kR grows over fadeKR, since the
   * cylinder's formula holds for kR ≫ 1 and a ridge small against the wavelength diffracts as a
   * thin edge (class C).
   */
  ridge: Object.freeze({
    spanCells: 1,
    maximumRadiusMetres: 5000,
    fadeKR: Object.freeze([1, 10])
  }),
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
  /**
   * Shared scatter (the render's quality): a frame's scattered echoes are summed in groups by their
   * time spread, sharedClassesPerOctave of them per octave from scatterBinSeconds, and in
   * sharedVariants seeded variants of each, and every group is spread once by sub-arrivals over its
   * class's spread (class C).
   */
  sharedClassesPerOctave: 1,
  sharedVariants: 2,
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

/**
 * A fireworks display (`fireworks.js`): spherical shells fired from mortars, each bursting high in
 * the air, some throwing out crackling stars.
 * - Burst height 1.4 m per millimetre of shell diameter (Wharton 1995, J. Pyrotechnics 1, a fit to
 *   Shimizu's and others' data, class B; 255 mm shells burst at 206–422 m), spread lognormally by
 *   heightSpread (class C). The shell bursts at the top of its flight (class C: its time fuse is
 *   set for it), fired straight up with a seeded tilt of tiltDegrees (class C).
 * - Gross shell mass massKilogramsPerCubicMetre·d³, 0.4 kg at 100 mm (class B, Wharton's table of
 *   75–125 mm shells, 177–768 g); a sphere of drag coefficient dragCoefficient (Ooki et al. 2006,
 *   Sci. Tech. Energetic Materials 67, 0.7–0.8 in free fall, class B) in the ground's air.
 * - The mortar's thump is a ground blast at the mortar's mouth, mouthMetres up, of thumpShare of
 *   the lift charge, liftShare of the shell's mass (Wharton: 6–20 %), as TNT, with a positive phase
 *   of thumpSeconds, about the time the shell takes to leave the tube (all class C: no measurement
 *   found).
 * - The burst is a TNT blast of burstShare of the shell's mass (class C, fitted to Maglieri &
 *   Henderson 1973, JASA 54, 342: 4–6 inch shells bursting at about 91 m gave up to 718 Pa below
 *   them; a 150 mm shell gives 720 Pa at the ground under it. Its pulse is TNT's, whose signature
 *   comes out longer than their about 12 ms).
 * - A crackling star leaves the burst at starMetresPerSecond in a seeded direction and slows by
 *   drag at the ballistic coefficient starKilogramsPerSquareMetre, under gravity; its pops come at
 *   seeded times from crackleDelaySeconds after the burst over crackleSeconds, each a tiny blast of
 *   the pop charge as TNT (all class C: no measurement found; stepped every starStepSeconds).
 */
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

/**
 * Secondary booms (`secondary.js`): the profile up to topMetres every stepMetres; the upper wind a
 * jet at jetHeightMetres, falling as exp(−((z − z_j)/jetWidthMetres)²), class C after the winter
 * polar vortex and summer easterlies around the stratopause; `rays` rays per table, one table per
 * azimuthStepDegrees of direction and heightStepMetres of the body's height, built only where a
 * table of coarseRays brings rays down within reachMargin of the range, cachedTables kept; a ray's absorption
 * taken at absorptionReferenceHz to scale the render's mean over its heights (class C).
 */
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
   * Turbulence near the ground bends a boom's front into spikes and rounds: the front is the direct
   * front plus `arrivals` seeded sub-arrivals of zero sum, delayed exponentially by the rise time on
   * average, of RMS `frontShare` at `referenceTurbulence`, growing with its square root (class C, not
   * fitted). Each part rises in the rise time over `riseRatio`, which puts the 1–4 kHz band 18 dB under
   * 80–250 Hz against 14–27 dB in recorded booms. The latest sub-arrival comes `longestRises` mean delays late.
   */
  turbulentFront: Object.freeze({
    arrivals: 24,
    frontShare: .5,
    referenceTurbulence: 1e-6,
    riseRatio: 10,
    longestRises: 8
  })
});

/**
 * A whip's crack is the boom of its tip, the cracker, flying faster than sound for about a
 * millisecond. Its motion after Krehl & Engemann (1998, "The puzzle of whip cracking", Shock Waves 8,
 * high-speed shadowgraphs of a bullwhip; class B): the tip goes from Mach 1 to its top speed (Mach
 * 2.19 measured) within accelerationMetres, the crack leaves as the lash turns it around, and it falls
 * below Mach 1 again within decelerationMetres. The turn is a half circle of turnRadiusMetres (class
 * C), and the path is sampled every stepSeconds. Before and after, the tip moves subsonicMetres at
 * an even rate between subsonicMach and Mach 1 (class C), so that the booms that leave as it
 * reaches and leaves the speed of sound are found. The boom follows Carlson's formula with the cracker's
 * length and shape factor (class C: a frayed cracker is not a body of revolution; Whitham's projectile
 * formula gives K_S = 2^¼·γ·d/l for a slender body of diameter d).
 */
export const WHIP = Object.freeze({
  accelerationMetres: .45,
  decelerationMetres: .2,
  turnRadiusMetres: .05,
  subsonicMetres: .3,
  subsonicMach: .5,
  stepSeconds: 2e-6
});

/**
 * A first stage falling back to its landing pad after its entry burn, tail first. Its speed follows
 * drag and gravity, dv/dt = g − ρv²/(2β), with its ballistic coefficient β = m/(C_D·A) (class A
 * given β; β of about 2 800 kg/m² brings a Falcon 9 below Mach 1 at 6–8 km, which Durrant et al.
 * 2022 report as about 6 km). The path is integrated every stepSeconds for at most maximumSeconds.
 *
 * Its boom is a triple boom (Durrant, Anderson, Gee, Mathews & Hart 2022, "Initial comparison of a
 * Falcon-9 reentry sonic boom with other launch-related noise", POMA 46, 045002; Anderson & Gee
 * 2025, JASA Express Letters 5, 023601): a front shock, a middle shock where the grid fins'
 * compression meets the lower body's expansion, and a rear shock. The expansions between the shocks
 * share one slope and the signature has no net area, as an aged far-field signature. The middle
 * shock comes at middleShare of the duration and jumps middleRatio of the front shock (class C,
 * fitted to their figure 5 at 8 km: front 130 Pa, the jump about 140 Pa at 0.198 of 0.290 s, the
 * expansions about 1 100–1 200 Pa/s; this signature gives −108, 32, and −79 Pa where they show
 * −105, 35, and −65 Pa).
 */
export const BOOSTER = Object.freeze({
  stepSeconds: .05,
  maximumSeconds: 600,
  middleShare: .68,
  middleRatio: 1.08
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
 * pressure^0.6; class C as a playback mapping): level differences shrink to 0.6 in decibels at
 * every frequency, without the ISO 226 contours. The level follows the ear's temporal integration
 * of loudness, of the order of 100 ms (class B, Zwicker & Fastl, Psychoacoustics; class C for the
 * two stages): a mean square over 25 ms, smoothed in decibels over 50 ms. With `capOnsets` no
 * sample comes out louder than the loudest going in.
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
  loudnessMaximumBoostDb: 40,
  /** The onset cap's gain changes by at most this many decibels per second, so it does not click (class C). */
  onsetCapSlewDbPerSecond: 2000
});

/**
 * A preview render, quicker for the same scene (measured 2.3 times on a ground flash over hills with
 * echoes): a flash's or storm's sources stand in for sourceMerge segments each, with their energy
 * together, its terrain's echo cells are echoCellScale times as large, and its paths are summed up
 * to highestHz, above which a thunder 1.4 km away holds 30 dB less than below. The sound keeps its
 * level, length, and colour; the channel's finest crackle coarsens. It is not exported.
 */
export const PREVIEW = Object.freeze({
  sourceMerge: 4,
  echoCellScale: 2,
  highestHz: 2000
});

/**
 * The Settings dialog's estimate of a render's cost against the full computation, fitted to a ground
 * flash over hills with terrain echoes (measured 2026-10-12): fixedShare of the time is tracing and
 * the like; the rest sums the paths' spectra, split between direct and scattered paths by their
 * counts. Their bins reach as far as the cutoff lets the air's absorption, which grows as f², about
 * referenceHz at the full cutoff, or the highest frequency where lower, and cost as their share to
 * binExponent. A flash's paths fall with its merging; scattered ones with echo cell scale to
 * cellExponent; arrivalShare of a scattered path's work is its sub-arrivals. A forest takes
 * forestShare of the bins' work at every frequency, which a coarse one saves; shared scatter saves
 * sharedSaving of the scattered paths' work (both measured on the same scene).
 */
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
  /** The longest span of arrivals a render holds. */
  maximumSeconds: 400,
  maximumSources: 1500000,
  maximumEmitters: 8,
  maximumReceivers: 8,
  /** Flights cover tens of kilometres, and meteors come from the upper atmosphere. */
  sceneExtentMetres: 300000,
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
  /**
   * At a fixed full scale, a peak this far above it is flagged as likely to break up playback rather
   * than only clip: samples many times full scale reach the output device, whose limiting or coding
   * can drop or distort the sound until it falls (seen with Loudness on a boom).
   */
  breakUpDecibels: 20,
  /** Without the real delay, the first sound starts this long after playback begins. */
  shortenedLeadSeconds: .5,
  /** Below this share of the peak a sample is silence, so playback without the real delay skips it. */
  silenceShare: 1e-4
});

export const VIEW = Object.freeze({
  /**
   * The box, sizes in screen pixels: padding as a share of the scene; turning and zooming per pixel of
   * drag, pinch, or wheel; pan in units of the box's half-extent; below degenerateArea a plane is seen
   * edge-on and offers no handles.
   */
  box: Object.freeze({
    marginPixels: 36,
    minimumSpanMetres: 100,
    /** The smallest box around whips alone, which crack within a metre. */
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
   * A fireworks shell's burst, representational only: `stars` stars fly out as FIREWORKS' crackling
   * stars do and burn out over burnSeconds (no longer than the flash stays on the screen).
   */
  fireworks: Object.freeze({
    stars: 32,
    burnSeconds: 1.2
  }),
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
   * `pieces` pieces kept above the ground where it may reach it. At most `bodies` of the strongest
   * cones are drawn at once, so a shower of hundreds costs what a few do, and their rings in
   * `levels` steps of strength, one stroke per step.
   */
  cone: Object.freeze({
    rings: 16,
    ringPoints: 32,
    lineEvery: 4,
    pieces: 12,
    alpha: .45,
    bodies: 24,
    levels: 12
  }),
  /**
   * Wavefronts: a front is drawn as strong as its sound where it has spread to, fully at topDb and gone
   * at floorDb (display only; model pascals, not calibrated). High in layered air a front is drawn in
   * homogeneous air once the linear profile strays more than localProfileTolerance. At most `groups` of
   * the strongest flashes, blasts, or rounds are drawn, since each costs its own composited outlines.
   */
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
  /**
   * The map on the floor: the finest zoom (OpenTopoMap serves up to 17) at which about pixelsAcross
   * pixels span the terrain, drawn opaque, its tiles turned into the palette: lightness of open land
   * and of the darkest lines, how much bluer than red water is, and how much it shows.
   */
  map: Object.freeze({
    // The map covers the floor the view shows, with viewMargin to spare; a low view sees no farther than minimumSine allows.
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
  /**
   * The terrain is drawn on a grid of at most drawCells a side, lit from the north-west and above;
   * outside the box it fades into the panel over fogShare of the box's width, and the edge of the
   * capture over edgeShare of its own width. Contours stripe it in about contourBands bands, and at
   * most maximumLabels place names are drawn.
   */
  terrain: Object.freeze({
    drawCells: 110,
    light: Object.freeze({ x: -1, y: 1, z: 1.6 }),
    fogShare: .6,
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
  /** Seconds a note stays in the scene's corner before it fades; an error stays. */
  statusSeconds: 8,
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
