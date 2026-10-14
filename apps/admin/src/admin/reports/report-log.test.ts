import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loggableFilters } from './report-log';

test('loggableFilters masks the free-text search (may hold a name or phone)', () => {
  const out = loggableFilters({ q: '054-1234567', limit: 50 });
  assert.deepEqual(out, { q: '[set]', limit: 50 });
  assert.ok(!JSON.stringify(out).includes('054'));
});

test('loggableFilters leaves filters without a search untouched', () => {
  assert.deepEqual(loggableFilters({ limit: 50, sort: 'createdAt' }), { limit: 50, sort: 'createdAt' });
});

test('loggableFilters drops an empty search instead of marking it set', () => {
  assert.deepEqual(loggableFilters({ q: '', limit: 10 }), { limit: 10 });
});

test('loggableFilters does not mutate the filters it was given', () => {
  const filters = { q: 'Tamar', limit: 5 };
  loggableFilters(filters);
  assert.deepEqual(filters, { q: 'Tamar', limit: 5 });
});
