import assert from 'node:assert/strict';
import test from 'node:test';
import { clearAppStorage } from '../src/app-reset.js';

test('reset removes all versions of this app’s data and leaves sibling apps intact', () => {
  const data = new Map([
    ['boomtect.scene.thunder', '{}'], ['boomtect.scene.sonic', '{}'], ['boomtect.preferences', '{}'],
    ['echotect:workspace:v4', '{}'], ['other', 'work']
  ]);
  const storage = { get length() { return data.size; }, key: index => [...data.keys()][index], removeItem: key => data.delete(key) };
  clearAppStorage(storage, 'boomtect.');
  assert.deepEqual([...data.keys()], ['echotect:workspace:v4', 'other']);
  data.set('echotect:workspace:v1', '{}');
  clearAppStorage(storage, 'echotect:');
  assert.deepEqual([...data.entries()], [['other', 'work']]);
});
