import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeholdersIn } from './interpolate';
import {
  CONTENT_GROUPS,
  CONTENT_REGISTRY,
  contentDefaults,
  contentKeys,
  getContentEntry,
} from './registry';

test('every key is unique', () => {
  const keys = CONTENT_REGISTRY.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('every default is non-empty (fail-safe fallback must never be blank)', () => {
  for (const e of CONTENT_REGISTRY) {
    assert.ok(e.default.trim().length > 0, `empty default for ${e.key}`);
    assert.ok(e.label.trim().length > 0, `empty label for ${e.key}`);
  }
});

test('a default only uses declared placeholders, and every declared one is used', () => {
  for (const e of CONTENT_REGISTRY) {
    const used = placeholdersIn(e.default).sort();
    const declared = [...(e.placeholders ?? [])].sort();
    assert.deepEqual(
      used,
      declared,
      `placeholder mismatch for ${e.key}: default uses [${used}], declared [${declared}]`,
    );
  }
});

test('every entry belongs to a known group', () => {
  const groups = new Set(CONTENT_GROUPS.map((g) => g.id));
  for (const e of CONTENT_REGISTRY) {
    assert.ok(groups.has(e.group), `unknown group ${e.group} for ${e.key}`);
  }
});

test('derived lookups agree with the registry', () => {
  assert.equal(contentKeys.size, CONTENT_REGISTRY.length);
  for (const e of CONTENT_REGISTRY) {
    assert.equal(contentDefaults[e.key], e.default);
    assert.equal(getContentEntry(e.key)?.key, e.key);
  }
  assert.equal(getContentEntry('does.not.exist'), undefined);
});
