# Boomtect

Boomtect is a browser-based acoustics laboratory for impulsive sound: lightning
and blasts. Place synthetic sources in 3D above the ground — a single ground
flash, a cloud flash, a whole storm, or an explosion — put microphones where you
want to listen, and hear how distance, height, air, and ground shape what
arrives. Thunder is modelled as what it is — long, tortuous, branching channels
of sources at different heights — rather than as one point.

## Using it

- **Elevation** (east–height) and **Plan** (east–north) show the same 3D scene.
  Drag a channel's ends, a storm's centre, a blast, or a microphone in either
  view.
- **+ Ground flash** and **+ Cloud flash** add one flash you shape yourself.
  **+ Storm** generates many flashes over a disc and a time window, mixing
  ground and cloud flashes under an adjustable cloud layer. Every emitter has
  an onset, so flashes can be staggered in time.
- **Play** flashes the source and plays the sound at the selected microphone.
  With **Real delay** the sound arrives as late as it would outdoors; without
  it, the silence before the first sound is skipped.
- **Variant** copies the selected emitter with a new seed, so two flashes or
  storms with the same parameters but a different shape can be compared.
- **Export WAV** writes the selected microphone as a mono 32-bit float WAV and a
  JSON document with the full scene, the time of the first sample after the
  flash, and the pascals that correspond to full scale. That JSON opens as a
  scene.
- **Save** and **Open** store and restore scenes as JSON. The current scene is
  also kept in the browser between visits.

## Model

Every source is a set of point emitters, each with a position, an emission
time, and a pressure pulse. The pressure at a microphone is the sum of every
emitter's pulse, delayed by its travel time and shaped by the path.

| Part | Model | Class |
|---|---|---|
| Speed of sound | `c = sqrt(γRT)` | A |
| Travel time and spreading | straight path, `1/R` per point emitter | A |
| Channel segment directivity | uniform line element, `sinc(πfℓ·cosψ/c)` | A |
| Lightning pulse | N-wave with period `τ₀ = 2.81·R₀/c`, `R₀ = sqrt(E/(πp))` (Few, ReVelle) | B |
| Weak shock | period grows as `x^¼`, extra decay `x^-¼` with distance (ReVelle) | B |
| Lightning level | acoustic share of channel energy | C |
| Channel shape | seeded two-scale zigzag with branches of branches | C |
| Strokes | lognormal intervals, new ground points on later strokes | B/C |
| Segment radiation | straight element shorter than the segment | C |
| Energy along the channel | seeded lognormal variation | C |
| Storm | seeded flash positions, onsets, types, strokes, energies | B/C |
| Blast pulse | Friedlander waveform | B |
| Blast level | Kinney & Graham (1985) overpressure at a linearization radius | B |
| Blast duration | cube-root scaling from a reference duration | C |
| Air absorption | ISO 9613-1 | B |
| Ground reflection | image source with Delany–Bazley impedance and spherical-wave coefficient | B |

**A** — first principles, **B** — literature, **C** — heuristic or synthetic.
The panel marks each parameter with its class.

Not modelled: terrain and buildings, diffraction, temperature stratification
and refraction, wind and turbulence, and nonlinear propagation beyond the
linearization radius. Levels are model values in pascals and are not
calibrated. A synthetic channel is not a reconstruction of a real strike.

## Running locally

```sh
npm start
```

Then open http://localhost:8000/. Tests run with `npm test` (Node 20 or later).
Rendering runs on several worker threads.
There is no build step and no dependency to install.

## License

MIT
