// -----------------------------------------------------------------------------
// Unit tests for the configuration normalization.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  isConfigured,
  normalizeConfig,
  POLL_FREQUENCY_LIMITS,
} from '../src/config.js';

test('normalizeConfig fills defaults when nothing is given', () => {
  const config = normalizeConfig();
  assert.equal(config.username, '');
  assert.equal(config.password, '');
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('normalizeConfig trims the username and password', () => {
  const config = normalizeConfig({
    username: '  you@example.com  ',
    password: '  secret  ',
  });
  assert.equal(config.username, 'you@example.com');
  assert.equal(config.password, 'secret');
});

test('normalizeConfig clamps the poll frequency to the manifest bounds', () => {
  assert.equal(normalizeConfig({ poll_frequency: '5' }).poll_frequency, POLL_FREQUENCY_LIMITS.min);
  assert.equal(
    normalizeConfig({ poll_frequency: '999999' }).poll_frequency,
    POLL_FREQUENCY_LIMITS.max,
  );
  assert.equal(
    normalizeConfig({ poll_frequency: 'NaN' }).poll_frequency,
    DEFAULT_CONFIG.poll_frequency,
  );
});

test('isConfigured requires both the username and the password', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ username: 'you@example.com' })), false);
  assert.equal(isConfigured(normalizeConfig({ password: 'secret' })), false);
  assert.equal(
    isConfigured(normalizeConfig({ username: 'you@example.com', password: 'secret' })),
    true,
  );
});

test('normalizeConfig preserves unknown keys (future-proof)', () => {
  const config = normalizeConfig({ some_future_option: 'x' });
  assert.equal(config.some_future_option, 'x');
});
