---
name: boomtect-sound
description: Renders lightning, storms, blasts, barrages, fireworks, volcanic explosions, sonic booms, meteors, whips, and falling boosters from a request in words, at a place and microphone the request describes, and checks the result by measurement. Use when the user asks for such a sound, a collection of them, or a supersonic jet with its engine.
---

# Boomtect sound

Requires Node 20 or later; no packages.

## Workflow

1. Translate the request with the table in README.md, section "Writing a scene". Timbre words decide the source as much as its kind: "crack", "sharp" point to a short rise time or a near source, "rolling", "ragged" to a longer, more branched channel.
2. Copy the nearest scene in `examples/` and change only what the request names. Missing fields take their defaults; `src/domain/scene.js` lists every field with its range. App macros are not fields; set the fields they move.
3. Run `node tools/render.mjs <scene.json> <folder>`. Add `--ambix` only for spatial audio.
4. Check the printed summary against the request:
   - dark or bright: `spectralCentroidHz`, and the 2000 Hz and 4000 Hz octaves below the loudest band;
   - long or short: `withinFortyDecibelsSeconds`;
   - loud or soft, near or far: `loudestDecibelsAFast`, not `peakDecibelsSpl`, which follows infrasound.

   If a word is missed, change one field and render again. Stop after three renders.
5. Hand over the WAV and the filled `scene.json`, with what you chose in a few lines and the next field to change.

## Cases

- **A real place:** GPS coordinates in `place` and `"terrain": { "enabled": true }`. Use the coordinates you know for a named place and put the microphone where the description puts it; ask only when unsure, and never send an address to a search service unasked. README, "Writing a scene".
- **A supersonic jet with its engine:** README, "From the command line", with Rumbletect cloned beside this repository. Hand over the mix and each part.
- **A collection whose levels compare:** render the loudest scene first, then set `"render": { "levelMode": "fixed", "fullScalePa": <its fullScalePa> }` in every scene. A new `seed` gives another take. Run renders in parallel; each uses one core.
