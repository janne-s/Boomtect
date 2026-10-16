import { applyEar } from './domain/ear.js';

self.addEventListener('message', ({ data }) => {
  const { sampleRate, reflex, loudness, capOnsets, parts } = data;
  try {
    const results = parts.map(channels => applyEar(channels, sampleRate, { reflex, loudness, capOnsets }));
    self.postMessage({ type: 'result', results }, results.flat().map(channel => channel.buffer));
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
