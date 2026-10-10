# Boomtect: Build thunder where you want it

Boomtect simulates the sound of lightning and blasts from their physics. Shape
a flash or a whole storm in 3D above the ground, place microphones, and hear
how distance, height, layered air, terrain, and ground shape what arrives. Listen in mono, as a
spaced stereo pair, or binaurally on headphones, and export WAV or Ambisonics.

## How it works

Every source is a set of points, each with a position, an emission time, and a
pressure pulse. A lightning channel is thousands of them along a branching,
zigzagging path; a blast is one. Each pulse travels to each microphone with its
own delay and loss, and the microphone hears their sum.

Thunder and Blast are separate modes, each with its own scene.

## Scene

- **Box** — The floor is the ground and the two far walls show the scene from
  the side. The cross on the floor is the origin. Terrain beyond the box fades
  out.
- **Points and shadows** — Drag a point to move it horizontally, or its shadow
  on the floor or a wall to move it in that plane.
- **View** — Drag empty space to turn, pinch or wheel to zoom, two fingers,
  Shift-drag, or the right button to pan, double-click to reset.
- **Channel ends** — A channel starts at the dark circle and ends at the white
  one. A storm's edge handle sets its size, and its grey handles move the
  cloud base and top up and down.
- **Selection** — Dashed lines lead from a selected microphone, blast, or channel
  end to its shadows on the floor and walls. A click on empty space clears it.
- **Shadow boundary** — The line on the ground beyond which refraction lifts the
  selected emitter's sound off the ground, for the microphone's height.

## Emitters

- **Ground flash** — A channel from the ground into the cloud, where it spreads
  sideways. Later strokes follow the same channel or strike a new ground point.
- **Cloud flash** — A channel inside the cloud; its sound spreads out in time.
- **Storm** — Ground and cloud flashes over an area, a time span, and a cloud
  layer.
- **Blast** — An explosion of a given charge.
- **Macros** — Energy, height, branching, zigzag, crack, and strokes for a
  flash; size, duration, flashes, ground share, and cloud layer for a storm.
  Each sets several parameters at once.
- **Details** — Every parameter, marked A (first principles), B (literature),
  or C (heuristic or synthetic).
- **New shape** — Draws a new random seed.
- **Variant** — Copies the emitter with a new seed and switches the original
  off.
- **Onset** — Delays an emitter in the scene.

## Listening

- **Render** and **Play** — The button renders the scene when it has changed,
  then plays it: it flashes the sources and plays what the listening microphones
  hear.
- **Auto** — Renders again soon after every change. Off, changes wait for
  Render.
- **In progress** — Rendering and loading are listed in the corner of the
  scene while they run, each with how far it has come, how long it has run, and
  for requests over the network when it gives up.
- **Real delay** — On: the sound arrives as late as it would outdoors, and the
  clock in the corner counts from the flash, its bar brightening when the sound
  arrives. Off: the silence before the first sound is skipped, and the channel
  glows where the sound being heard comes from.
- **Wavefront** — While the sound plays, shows the wavefronts as ripples where
  they cross the floor, the terrain, and the walls.
- **Names** — Place names, peaks, and lakes on the terrain.
- **Cloud** — A storm's cloud as dark fog, lit around the flashes inside it.
- **i** — The sources of the terrain and map data.
- **Listen** — The checkbox on a microphone adds it to what plays. During
  playback, the sound continues from the same moment with the new combination.
  Microphones that do not listen still show their level, muted.
- **Type** — Omni hears the pressure. Binaural hears the sound field, turned to
  its orientation and decoded for headphones; it switches Spatial on.
- **Orientation** — Facing and elevation of a binaural microphone. On the
  sphere beside the scene, drag the handle on the horizon to face and the one
  on the scale beside it to tilt, or drag the arrowhead in the scene.
- **Combinations** — One omni microphone is mono, two are a stereo pair, more
  are one channel each. One binaural microphone is binaural; binaural and omni
  together are a stereo mix with the omni microphones in the centre. Surround
  plays one channel per speaker when the output has them, and otherwise as a
  stereo preview.
- **Spatial** — The Ambisonic order of the render, or Off.
- **Ear reflex** — The middle-ear reflex: after a loud onset, the low
  frequencies are turned down with a short delay, and the effect fades while
  the sound continues.
- **Loudness** — Compresses level differences the way perceived loudness
  grows with pressure.
- **Level** — Normalizes to the peak, or uses a fixed full scale in pascals.
- **Plots** — Pressure and arrival time by source height for every microphone
  on one time axis and one pressure scale, each in its own color and the muted
  ones dimmer. A microphone's tab, or selecting the microphone, brings it
  forward.

## Air

- **Lapse rate** — How fast the temperature falls with height; 6.5 K/km is the
  standard atmosphere, a negative value an inversion.
- **Refraction** — Sound bends toward slower air. Falling temperature
  bends it up and leaves a shadow on the ground, where thunder fades out; an
  inversion bends it down and carries it far. Off: homogeneous air, the
  free-field reference.
- **Shadow floor** — How far below the unbent level the shadow can go, set by
  turbulent scattering.
- **Ground** — What the ground is made of. Water reflects like rigid ground.
- **Forest** and **Tree height** — Trees around the scene: sound under their
  canopy is muffled, and the forest answers every sound with a reverberant tail.
- **Wind**, **Wind from**, and **Wind shear** — The wind at the ground, the
  compass direction it comes from, and how much it strengthens with height.
  Downwind, sound bends down and carries; upwind, the shadow comes closer.
- **Vapour height** — How quickly the water vapour thins out with height,
  which changes how much the upper air absorbs.
- **Tropopause** — Where the temperature stops falling; above it the air keeps
  one temperature.
- **Ground layer** and **Layer lapse** — A layer of air next to the ground with
  its own lapse rate, such as a low inversion on a calm night.

## Terrain

- **Place** — Where the scene's origin lies. The map button opens a map to
  move under the centre mark, with the area to be loaded around it.
- **Area** and **Resolution** — The size of the square of terrain around the
  origin and the spacing of its heights.
- **Find** — Finds a place by name, or takes "latitude, longitude", and loads
  its terrain.
- **Load terrain** — Fetches the elevation, at least as wide as the scene, and
  saves it in the scene, so the scene opens the same way later without a
  connection. Place names follow on their own. While terrain is on, a scene that
  grows past its edge loads a wider area around the same origin.
- **Terrain** — Microphones, blasts, and ground points stand on the ground;
  heights in the cloud are above the ground at the origin. The panel shows both
  heights above the ground and above sea level.
- **Shielding** — Hills between a source and a microphone block the direct and
  the reflected sound, and sound bends over their crests, more at low
  frequencies.
- **Echoes** — Slopes the source and the microphone both see send the sound
  back: sharply from where they mirror it, and scattered from everywhere else.
- **Scattering** — The share of the echo that scatters; the rest mirrors.
- **Echo cells** — Sources this close together share their echoes.
- **Echoes per cell** — The strongest echoes kept for each cell.
- **Contours** — Stripes the terrain by height.

## Export

**Export** packs the chosen files, several of them in a ZIP:

- **Scene** — The full scene as JSON, with the files, the time of their first
  sample after the flash, and the pascals at full scale. It opens as a scene.
- **Stereo** — What plays, in two channels: mono on both, a pair left and right,
  more microphones panned, binaural as heard on headphones.
- **Microphones** — One file per microphone: an omni's pressure in mono, a
  binaural microphone in stereo.
- **Ambisonics** — One AmbiX file per microphone (ACN, SN3D; front is north,
  left is west), when the render is spatial.

All files are 32-bit float at one full scale. With per-microphone files, every
file starts at the same moment.

## Echotect

To place a Boomtect sound in an [Echotect](https://github.com/janne-s/Echotect)
echo field, export a microphone's file and load it in Echotect as the source sound.

## Model

| Part | Model | Class |
|---|---|---|
| Speed of sound | `c = sqrt(γRT)` | A |
| Temperature profile | layers: a ground layer, the troposphere, constant above the tropopause (ISO 2533) | B/C |
| Sound speed along a path | linear from the ground, matched to the layered speed's mean slowness over the path's heights | C |
| Travel time, rays, and spreading | circular rays in a linear `c(z)`, ray tubes; `1/R` without refraction | A |
| Wind | effective sound speed along each path, linear in height | B/C |
| Refraction shadow | grazing ray, creeping wave along the ground (Fock), softer over porous ground at high frequencies, floor; over terrain, heights above the mean ground plane between source and microphone (CNOSSOS-EU) | B/C |
| Segment directivity | straight line element | A |
| Lightning pulse | N-wave, period `2.81·R₀/c`, `R₀ = sqrt(E/(πp))` (Few, ReVelle) | B |
| Weak shock | period grows as `x^¼`, extra decay `x^-¼` (ReVelle) | B |
| Strokes | lognormal intervals, new ground points | B/C |
| Return-stroke current | decays with height, `e^(-z/λ)` (MTLE); energy as its square | B/C |
| In-cloud channels | sideways channels from a ground flash's top, thinning out | C |
| Channel shape | seeded two-scale zigzag with branches of branches | C |
| Lightning level | acoustic share of channel energy | C |
| Blast | Friedlander pulse, Kinney & Graham overpressure | B |
| Shock front | stays steep against absorption while a shock; merges with its grazing reflection (von Neumann) | B/C |
| Air absorption | ISO 9613-1; with refraction, the mean over the heights a path spans, the vapour thinning out with height | B |
| Ground reflection | Delany–Bazley impedance, spherical-wave coefficient; from the slope under the microphone over terrain | B |
| Forest, under the canopy | ISO 9613-2 foliage attenuation as `0.006·f^(1/3)` dB/m, up to 200 m, with a causal phase | B |
| Forest reverberation | seeded diffuse tail at the microphone, octave times around 1.5 s at 1 kHz (Koli, Finland) | B/C |
| Repeated ground contacts | rays an inversion or a following wind bends back down, up to six contacts, over level ground | A/C |
| Terrain shielding | thin-edge Fresnel–Kirchhoff diffraction, Deygout's edges | B |
| Terrain echoes, mirrored | stationary path on the surface, focusing by its curvature | A |
| Terrain echoes, scattered | Lambert's law per patch of ground | B |
| Echoes near the ground | the ground's image at the source and microphone ends, rigid within a blast's nonlinear radius | B/C |
| Echoes through the shadow | a leg in the refraction shadow keeps the shadow floor, as the direct sound | C |
| Echo cells and merging | sources pooled in cells; scattered echoes merged by arrival and direction | C |
| Turbulence | phase fluctuation of the ground reflection | B/C |
| Ambisonics | spherical harmonics, AmbiX | A |
| Ear reflex | threshold, latency, low-frequency attenuation, adaptation | B/C |
| Loudness | Stevens' power law on the level envelope | B/C |

Not modelled: echoes from buildings and clouds, repeated echoes, echoes over
ridges, rounded ridges (they shield more than thin edges), terrain finer than
the heightfield, gusts, more than six ground contacts, repeated contacts over
sloping ground, rays bending through several layers in turn, nonlinear
propagation beyond the linearization radius, the forest's reverberation around
the source, a forest that covers only part of the terrain.
Levels are model values in pascals and are not calibrated, so the ear model's
response to level is only as reliable as the model's level.

## Running locally

```sh
npm start
```

Open http://localhost:8000/. Run the tests with `npm test`.

## Data

Terrain heights: [Terrain Tiles](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
by Mapzen on AWS Open Data (SRTM, GMTED2010, NED, ETOPO1, EU-DEM, and national
datasets). Place search: [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/).
Map and place names: © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors, through the Overpass API for the names.
Both are fetched only when asked for.

## Third-party code

Binaural decoding uses [Omnitone](https://github.com/GoogleChrome/omnitone)
1.3.0 with its SADIE HRIRs, under the Apache License 2.0
([notice](assets/vendor/omnitone/NOTICE)).

## License

MIT
