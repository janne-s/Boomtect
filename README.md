# Boomtect

Boomtect is a browser-based acoustics laboratory for impulsive sound: lightning
and blasts. Place a synthetic source in 3D above the ground, put microphones
where you want to listen, and hear how distance, height, air, and ground shape
what arrives. Thunder is modelled as what it is — a long, tortuous channel of
sources at different heights — rather than as one point.

## Using it

- **Elevation** (east–height) and **Plan** (east–north) show the same 3D scene.
  Drag a channel's base or top, a blast, or a microphone in either view.
- **Play** flashes the source and plays the sound at the selected microphone.
  With **Real delay** the sound arrives as late as it would outdoors; without
  it, half a second after the flash.
- **Variant** copies the selected emitter with a new seed, so two channels with
  the same parameters but a different shape can be compared.
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
| Lightning pulse | N-wave peaking at `κ·c/R₀`, `R₀ = sqrt(E/(πp))` (Few) | B |
| Lightning level | acoustic share of channel energy | C |
| Channel shape | seeded tortuous walk from base to top | C |
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
There is no build step and no dependency to install.

## License

MIT
