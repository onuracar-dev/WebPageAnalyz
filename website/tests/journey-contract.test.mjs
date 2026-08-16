import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_JOURNEY_DEFINITION,
  DEFAULT_JOURNEY_JSON,
  validateJourneyJson,
} from '../src/portal/journeyContract.ts';

test('Engine Lab ships a backend-compatible read-only Journey definition', () => {
  assert.equal(validateJourneyJson(DEFAULT_JOURNEY_JSON, 'https://example.com/account'), '');
  assert.deepEqual(DEFAULT_JOURNEY_DEFINITION.steps.map((step) => step.action), ['goto', 'expectVisible']);
});

test('Engine Lab catches the former one-step smoke and unsafe navigation before submit', () => {
  const formerDefault = JSON.stringify({ name: 'Admin read-only smoke', steps: [{ action: 'expectVisible', selector: 'body' }] });
  assert.match(validateJourneyJson(formerDefault, 'https://example.com'), /between 2 and 20 steps/);
  const crossOrigin = JSON.stringify({ name: 'Unsafe', steps: [{ action: 'goto', path: 'https://other.example/' }, { action: 'expectVisible', selector: 'body' }] });
  assert.match(validateJourneyJson(crossOrigin, 'https://example.com'), /target origin/);
});
