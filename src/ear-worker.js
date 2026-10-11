import { applyEar } from './domain/ear.js';

/** The ear model off the page: each part's channels processed with one setting, in the order given. */
self.addEventListener('message', ({ data }) => {
  const { sampleRate, reflex, loudness, parts } = data;
  try {
    const results = parts.map(channels => applyEar(channels, sampleRate, { reflex, loudness }));
    self.postMessage({ type: 'result', results }, results.flat().map(channel => channel.buffer));
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
