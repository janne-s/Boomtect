# Boomtect: Build thunder where you want it

Boomtect simulates the sound of lightning and blasts from their physics. Shape
a flash or a whole storm in 3D above the ground, place microphones, and hear
how distance, height, air, and ground shape what arrives. Listen in mono, as a
spaced stereo pair, or binaurally on headphones, and export WAV or Ambisonics.

## How it works

Every source is a set of points, each with a position, an emission time, and a
pressure pulse. A lightning channel is thousands of them along a branching,
zigzagging path; a blast is one. Each pulse travels to each microphone with its
own delay and loss, and the microphone hears their sum.

Thunder and Blast are separate modes, each with its own scene.

## Scene

- **Box** — The floor is the ground and the two far walls show the scene from
  the side. The cross on the floor is the origin.
- **Points and shadows** — Drag a point to move it horizontally, or its shadow
  on the floor or a wall to move it in that plane.
- **View** — Drag empty space to turn, pinch or wheel to zoom, two fingers,
  Shift-drag, or the right button to pan, double-click to reset.
- **Channel ends** — A channel starts at the dark circle and ends at the white
  one. A storm's edge handle sets its size.

## Emitters

- **Ground flash** — A channel from the ground into the cloud. Later strokes
  follow the same channel or strike a new ground point.
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

- **Play** — Flashes the sources and plays what the listening microphones hear.
- **Real delay** — On: the sound arrives as late as it would outdoors. Off: the
  silence before the first sound is skipped, and the channel glows where the
  sound being heard comes from.
- **Listen** — The checkbox on a microphone adds it to what plays.
- **Type** — Omni hears the pressure. Binaural hears the sound field, turned to
  its orientation and decoded for headphones.
- **Orientation** — Facing and elevation of a binaural microphone. Drag the
  arrow's tip on the sphere or in the scene.
- **Combinations** — One omni microphone is mono, two are a stereo pair, more
  are one channel each. One binaural microphone is binaural; binaural and omni
  together are a stereo mix with the omni microphones in the centre. Surround
  plays one channel per speaker when the output has them, and otherwise as a
  stereo preview.
- **Spatial** — The Ambisonic order of the render, or Off.
- **Level** — Normalizes to the peak, or uses a fixed full scale in pascals.

## Export

**Export WAV** writes 32-bit float WAV files of what plays — mono, a pair, one
channel per omni microphone, or binaural stereo with an AmbiX file per binaural
microphone (ACN, SN3D; front is north, left is west) — and a JSON file with the
full scene, the time of the first sample after the flash, and the pascals at
full scale. The JSON opens as a scene.

## Echotect

To place a Boomtect sound in an [Echotect](https://github.com/janne-s/Echotect)
echo field, export a mono WAV and load it in Echotect as the source sound.

## Model

| Part | Model | Class |
|---|---|---|
| Speed of sound | `c = sqrt(γRT)` | A |
| Travel time and spreading | `1/R` per point | A |
| Segment directivity | straight line element | A |
| Lightning pulse | N-wave, period `2.81·R₀/c`, `R₀ = sqrt(E/(πp))` (Few, ReVelle) | B |
| Weak shock | period grows as `x^¼`, extra decay `x^-¼` (ReVelle) | B |
| Strokes | lognormal intervals, new ground points | B/C |
| Channel shape | seeded two-scale zigzag with branches of branches | C |
| Lightning level | acoustic share of channel energy | C |
| Blast | Friedlander pulse, Kinney & Graham overpressure | B |
| Air absorption | ISO 9613-1 | B |
| Ground reflection | Delany–Bazley impedance, spherical-wave coefficient | B |
| Turbulence | phase fluctuation of the ground reflection | B/C |
| Ambisonics | spherical harmonics, AmbiX | A |

Not modelled: terrain and buildings, diffraction, temperature stratification
and refraction, wind, nonlinear propagation beyond the linearization radius.
Levels are model values in pascals and are not calibrated.

## Running locally

```sh
npm start
```

Open http://localhost:8000/. Run the tests with `npm test`.

## Third-party code

Binaural decoding uses [Omnitone](https://github.com/GoogleChrome/omnitone)
1.3.0 with its SADIE HRIRs, under the Apache License 2.0
([notice](assets/vendor/omnitone/NOTICE)).

## License

MIT
