import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mapLabels } from '../src/domain/map-labels.js';

test('a real OpenFreeMap tile provides Unicode settlements, mountain elevation and lake labels', () => {
  const bytes = readFileSync(new URL('./fixtures/openfreemap-12-2318-1155.pbf', import.meta.url));
  const labels = mapLabels(bytes, { zoom: 12, x: 2318, y: 1155 });
  const peak = labels.find(item => item.name === 'Vuoresvuori');
  assert.equal(peak.kind, 'peak');
  assert.equal(peak.elevationMetres, 193);
  assert.ok(Math.abs(peak.latitude - 61.43141102117903) < 1e-10);
  assert.ok(Math.abs(peak.longitude - 23.765616416931152) < 1e-10);
  assert.equal(labels.find(item => item.name === 'Tampere').kind, 'city');
  assert.equal(labels.find(item => item.name === 'Pirkkala').kind, 'town');
  assert.equal(labels.find(item => item.name === 'Hervantajärvi').kind, 'water');
  assert.ok(labels.every(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude)));
});

test('malformed, truncated and oversized tile data fails without looping', () => {
  assert.throws(() => mapLabels(Uint8Array.of(26, 255), { zoom: 12, x: 0, y: 0 }));
  assert.throws(() => mapLabels(Uint8Array.of(31), { zoom: 12, x: 0, y: 0 }));
  assert.throws(() => mapLabels(new Uint8Array(16 * 1024 * 1024 + 1), { zoom: 12, x: 0, y: 0 }));
});
