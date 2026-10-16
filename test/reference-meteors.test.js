import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { digest, REFERENCE_CASES, REFERENCE_FILE, renderCase } from './reference-scenes.js';

const { cases } = JSON.parse(readFileSync(REFERENCE_FILE, 'utf8'));

for (const item of REFERENCE_CASES.filter(entry => entry.group === 'meteors')) {
  test(`${item.name} renders bit for bit as the reference`, () => assert.equal(digest(renderCase(item)), cases[item.name]));
}
