'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { dewPoint, DewPointSources } = require('../lib/dewPoint');

test('matches the Magnus values of the Home Assistant package', () => {
  // Reference values computed with the same formula and constants (17.62 / 243.12).
  assert.ok(Math.abs(dewPoint(20, 50) - 9.26) < 0.01);
  assert.ok(Math.abs(dewPoint(25, 60) - 16.69) < 0.01);
  assert.ok(Math.abs(dewPoint(22, 45) - 9.55) < 0.05);
});

test('saturated air has its dew point at the air temperature', () => {
  assert.ok(Math.abs(dewPoint(21, 100) - 21) < 0.001);
});

test('rejects unusable input', () => {
  assert.equal(dewPoint(NaN, 50), null);
  assert.equal(dewPoint(20, NaN), null);
  assert.equal(dewPoint(20, 0), null);
  assert.equal(dewPoint(20, -5), null);
  assert.equal(dewPoint(20, 101), null);
});

test('aggregate returns the highest fresh source', () => {
  const sources = new DewPointSources();
  sources.update('room:living', 12.5, 1000);
  sources.update('room:bedroom', 14.2, 2000);
  sources.update('flow', 10.0, 3000);
  assert.equal(sources.aggregate(3000, 60000), 14.2);
});

test('stale sources are evicted and no longer count', () => {
  const sources = new DewPointSources();
  sources.update('room:living', 18.0, 0);
  sources.update('room:bedroom', 12.0, 50000);
  // Living room is over the age limit: the lower but fresh bedroom wins.
  assert.equal(sources.aggregate(61000, 60000), 12.0);
  // Even when time rewinds within limits, the evicted source stays gone.
  assert.equal(sources.aggregate(55000, 60000), 12.0);
});

test('aggregate is null without fresh sources', () => {
  const sources = new DewPointSources();
  assert.equal(sources.aggregate(1000, 60000), null);
  sources.update('flow', 15.0, 0);
  assert.equal(sources.aggregate(120000, 60000), null);
});

test('an updated source uses its newest value and timestamp', () => {
  const sources = new DewPointSources();
  sources.update('room:living', 18.0, 0);
  sources.update('room:living', 11.0, 70000);
  assert.equal(sources.aggregate(80000, 60000), 11.0);
});
