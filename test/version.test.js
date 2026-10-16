import test from 'node:test';
import assert from 'node:assert/strict';

test('the application version is the one in package.json', async () => {
  const { APP_VERSION } = await import('../src/domain/constants.js');
  const { readFileSync } = await import('node:fs');
  assert.equal(APP_VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});
