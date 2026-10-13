import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestTask } from '../src/ui/latest-task.js';

test('a superseded task cannot finish or clear the new task', () => {
  const jobs = createLatestTask();
  const old = jobs.start();
  const next = jobs.start();
  assert.equal(old.signal.aborted, true);
  assert.equal(old.current(), false);
  assert.equal(jobs.finish(old), false);
  assert.equal(next.current(), true);
  assert.equal(jobs.busy, true);
  assert.equal(jobs.finish(next), true);
  assert.equal(next.signal.aborted, true, 'finishing releases any remaining parallel requests');
  assert.equal(jobs.busy, false);
});

test('cancel makes a late result ineligible', () => {
  const jobs = createLatestTask();
  const task = jobs.start();
  jobs.cancel();
  assert.equal(task.signal.aborted, true);
  assert.equal(task.current(), false);
  assert.equal(jobs.finish(task), false);
});

test('a timeout aborts the request while retaining ownership for error reporting', async () => {
  const jobs = createLatestTask();
  const task = jobs.start(5);
  await new Promise(resolve => task.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(task.current(), true);
  assert.equal(jobs.finish(task), true);
});
