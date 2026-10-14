import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderMarker, unfinishedRenderText } from '../src/ui/render-marker.js';

const memoryStorage = (entries = []) => {
  const data = new Map(entries);
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
};

test('a render that ends leaves no mark; one that stops mid-phase leaves its phase', () => {
  const storage = memoryStorage();
  const marker = createRenderMarker(storage, 'mark');
  marker.phase('Preparing sources', { preview: false });
  marker.phase('Tracing paths', { sources: 41012 });
  marker.phase(null);
  assert.equal(createRenderMarker(storage, 'mark').take(), null);
  marker.phase('Preparing sources', { preview: true });
  marker.phase('Tracing paths', { sources: 41012 });
  marker.phase('Tracing paths');
  const next = createRenderMarker(storage, 'mark');
  assert.deepEqual(next.take(), { preview: true, sources: 41012, phase: 'Tracing paths' });
  assert.equal(next.take(), null, 'the mark is reported once');
});

test('a page hidden normally clears the mark and a restored one writes it again', () => {
  const storage = memoryStorage();
  const marker = createRenderMarker(storage, 'mark');
  marker.phase('Rendering', { sources: 10 });
  marker.suspend();
  assert.equal(storage.data.has('mark'), false);
  marker.restore();
  assert.deepEqual(JSON.parse(storage.data.get('mark')), { sources: 10, phase: 'Rendering' });
});

test('a broken mark still reports an unfinished render; missing storage reports none', () => {
  assert.deepEqual(createRenderMarker(memoryStorage([['mark', '{broken']]), 'mark').take(), {});
  assert.deepEqual(createRenderMarker(memoryStorage([['mark', '7']]), 'mark').take(), {});
  const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const marker = createRenderMarker(unavailable, 'mark');
  marker.phase('Tracing paths');
  marker.phase(null);
  assert.equal(marker.take(), null);
});

test('the report names what the mark still holds', () => {
  assert.equal(unfinishedRenderText({ phase: 'Tracing paths', sources: 41012 }), 'The last render did not finish (Tracing paths, 41,012 point sources)');
  assert.equal(unfinishedRenderText({ phase: 'Rendering', preview: true }), 'The last render did not finish (Rendering, Preview)');
  assert.equal(unfinishedRenderText({ phase: 3, sources: 'many' }), 'The last render did not finish');
});
