---
name: boomtect-sound
description: Make a sound with Boomtect from a request in words, such as "thunder three kilometres away on a humid summer night" — lightning, storms, blasts, barrages, fireworks, volcanic explosions, sonic booms, meteors, whips, and falling boosters, heard from a place you describe. Writes a scene, renders it in Node, checks the result by its measurements, and hands over the WAV and the scene.
---

# Make a sound with Boomtect

Boomtect is a creative sound tool, not a measurement: levels are uncalibrated model values, and a result is a plausible event. You cannot listen, so you steer by the measurements the renderer prints, and the person listens.

## Steps

1. **Read the table first.** README.md, section "Rendering from a script or an agent", maps changes to what they do to the sound. Translate the request's timbre words with it before choosing anything else: "crack", "sharp" or "thump", "soft", "rolling", "ragged" decide rise time, distance, and channel shape as much as the source does.
2. **Start from the nearest file in `examples/`.** Copy it to the output folder and change only what the request names: source kind and its size (channel, charge, body, speed), position and height, place (ground type, forest, surroundings), air (temperature, humidity, wind), and the microphone. A partial scene is enough; missing fields take their defaults. `src/domain/scene.js` lists every parameter with its range; app macros are not scene fields, so set the parameters they move.
3. **Render:** `node tools/render.mjs <scene.json> <folder>`. Most renders take seconds; storms, barrages, and terrain echoes take longer. Add `--ambix` only when spatial audio is asked for.
4. **Check against the request** with the JSON on stdout:
   - dark or bright: `spectralCentroidHz` and how far the 2000 Hz and 4000 Hz octaves lie below the loudest band;
   - long or short: `withinFortyDecibelsSeconds`;
   - near or far, loud or soft: `loudestDecibelsAFast`. `peakDecibelsSpl` follows the lowest bands and infrasound, so compare loudness in dB(A).

   If a word is clearly missed, change one thing and render again. Stop after two or three renders: the person's ear decides, not the numbers.
5. **Hand over** the WAV and the filled `scene.json` (it opens in the app for listening and further changes), say what you chose and why in a few lines, and name the next knob if the sound is not yet right.

## Notes

- The file starts at the first arriving sound.
- **A collection whose levels compare** (a series growing louder, takes to cut together): each file is otherwise scaled to its own peak, which hides the differences. Render the loudest scene first, then set `"render": { "levelMode": "fixed", "fullScalePa": <its fullScalePa> }` in every scene. Run several renders at once; each uses one core.
- The same scene and seed give the same sound; a new `seed` gives another take, such as another lightning channel.
- For continuous engine sound (jets, airliners, rockets, eruption jets) use Rumbletect, which has the same command.
