import assert from 'node:assert/strict';
import test from 'node:test';
import { HANDOFF_FORMAT, HANDOFF_VERSION, HandoffError, readHandoff, serializeHandoff } from '../src/domain/handoff.js';

const complete = () => ({
  format: HANDOFF_FORMAT,
  version: HANDOFF_VERSION,
  id: 'a1b2',
  producer: { app: 'boomtect', version: '0.65.0', modelVersion: '33.3.0' },
  kind: 'sound',
  name: 'Ground flash at Mic 1',
  createdAt: '2026-10-12T12:00:00.000Z',
  place: { name: 'Koli', latitudeDegrees: 63.0964, longitudeDegrees: 29.8061, datumMetres: 297 },
  air: { temperatureCelsius: 15, relativeHumidityPercent: 70, pressureKpa: 101.325 },
  listener: { positionMetres: { east: 1400, north: 0 }, heightAboveGroundMetres: 1.7, headingDegrees: 270, pitchDegrees: 0 },
  arrival: { azimuthDegrees: 270, elevationDegrees: 12, distanceMetres: 1400 },
  audio: { sampleRateHz: 48000, channels: 1, layout: 'pressure', sampleFormat: 'ieee-float32', fullScalePa: 20, startSeconds: 3.9, file: 'mic-1.wav' },
  content: { includes: ['direct', 'ground'], excludes: ['terrain-echoes'] },
  reliability: 'C'
});

test('a complete handoff reads as it was written and round-trips', () => {
  assert.deepEqual(readHandoff(complete()), complete());
  assert.deepEqual(readHandoff(JSON.parse(serializeHandoff(complete()))), complete());
});

test('a handoff of only its sound takes defaults, and leaves place, air, and arrival to the receiver', () => {
  const handoff = readHandoff({ format: HANDOFF_FORMAT, audio: { sampleRateHz: 48000, channels: 1, fullScalePa: 20 } });
  assert.equal(handoff.kind, 'sound');
  assert.equal(handoff.place, null);
  assert.equal(handoff.air, null);
  assert.equal(handoff.arrival, null);
  assert.deepEqual(handoff.listener, { positionMetres: { east: 0, north: 0 }, heightAboveGroundMetres: 0, headingDegrees: 0, pitchDegrees: 0 });
  assert.deepEqual(handoff.audio, { sampleRateHz: 48000, channels: 1, layout: 'pressure', sampleFormat: 'ieee-float32', fullScalePa: 20, startSeconds: 0, file: null });
  assert.equal(handoff.reliability, 'C');
  const place = readHandoff({ ...complete(), place: { latitudeDegrees: 60, longitudeDegrees: 24 } }).place;
  assert.deepEqual(place, { name: '', latitudeDegrees: 60, longitudeDegrees: 24, datumMetres: null });
});

test('the version neither blocks nor changes reading, and unknown fields and kinds are kept apart', () => {
  for (const version of [0, 7, undefined]) assert.deepEqual(readHandoff({ ...complete(), version }), complete());
  const extra = { ...complete(), colour: 'red', listener: { ...complete().listener, ear: 'left' }, audio: { ...complete().audio, bitDepth: 24 } };
  assert.deepEqual(readHandoff(extra), complete());
  assert.equal(readHandoff({ ...complete(), kind: 'impulse-response' }).kind, 'impulse-response');
});

test('a number outside its range is brought into it', () => {
  const handoff = readHandoff({ ...complete(), place: { ...complete().place, latitudeDegrees: 95 }, listener: { ...complete().listener, heightAboveGroundMetres: -2 }, audio: { ...complete().audio, channels: 1.4 } });
  assert.equal(handoff.place.latitudeDegrees, 90);
  assert.equal(handoff.listener.heightAboveGroundMetres, 0);
  assert.equal(handoff.audio.channels, 1);
});

test('only what is not a handoff, or is broken, is refused', () => {
  const broken = [
    null, [], 'handoff', { ...complete(), format: 'boomtect.scene' },
    { ...complete(), audio: undefined },
    { ...complete(), audio: { ...complete().audio, fullScalePa: undefined } },
    { ...complete(), audio: { ...complete().audio, sampleRateHz: 'fast' } },
    { ...complete(), place: { name: 'Koli' } },
    { ...complete(), arrival: { elevationDegrees: 3 } },
    { ...complete(), listener: 'here' },
    { ...complete(), content: { includes: 'direct' } }
  ];
  for (const value of broken) assert.throws(() => readHandoff(value), HandoffError);
});
