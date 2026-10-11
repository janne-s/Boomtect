import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, zipStore } from '../src/domain/zip.js';

test('the checksum is CRC-32, as its standard check value shows', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('a stored archive records each file with its checksum, size, and name', () => {
  const data = Uint8Array.from({ length: 1000 }, (_, index) => (index * 7) & 0xff);
  const archive = zipStore([{ name: 'a.wav', data }, { name: 'b.json', data: new TextEncoder().encode('{}') }]);
  const view = new DataView(archive.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(14, true), crc32(data));
  assert.equal(view.getUint32(18, true), data.length);
  assert.equal(new TextDecoder().decode(archive.subarray(30, 35)), 'a.wav');
  assert.deepEqual(archive.subarray(35, 1035), data);
  const end = archive.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
});
