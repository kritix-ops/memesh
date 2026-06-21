import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderHandoffThankyou, validateHandoffThankyouTemplate } from './handoff-thankyou';

test('renderHandoffThankyou substitutes {{firstName}}', () => {
  const out = renderHandoffThankyou('תודה, {{firstName}}!', { firstName: 'יואב' });
  assert.equal(out, 'תודה, יואב!');
});

test('renderHandoffThankyou falls back to לקוח/ה when firstName is empty', () => {
  for (const value of [null, undefined, '', '   ']) {
    const out = renderHandoffThankyou('שלום {{firstName}}', { firstName: value });
    assert.equal(out, 'שלום לקוח/ה');
  }
});

test('renderHandoffThankyou substitutes multiple occurrences', () => {
  const out = renderHandoffThankyou('{{firstName}} {{firstName}}', { firstName: 'נועה' });
  assert.equal(out, 'נועה נועה');
});

test('validateHandoffThankyouTemplate accepts templates with only {{firstName}}', () => {
  for (const tpl of ['no placeholders', 'hi {{firstName}}', '{{firstName}} x {{firstName}}']) {
    const res = validateHandoffThankyouTemplate(tpl);
    assert.equal(res.ok, true);
  }
});

test('validateHandoffThankyouTemplate rejects unknown placeholders', () => {
  const res = validateHandoffThankyouTemplate('hi {{firstName}}, {{name}}, {{lastName}}');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.deepEqual(res.unknown.sort(), ['lastName', 'name']);
  }
});

test('validateHandoffThankyouTemplate dedupes repeated unknown placeholders', () => {
  const res = validateHandoffThankyouTemplate('{{foo}} {{foo}} {{bar}}');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.deepEqual(res.unknown.sort(), ['bar', 'foo']);
  }
});
