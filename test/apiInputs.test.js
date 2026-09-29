'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { API_INPUTS, formatInput } = require('../lib/apiInputs');

test('formats numbers with two decimals inside the accepted range', () => {
  assert.equal(formatInput('dew_point', 15.6), '15.60');
  assert.equal(formatInput('outside_temperature', -40), '-40.00');
  assert.equal(formatInput('room_setpoint', 21), '21.00');
  assert.equal(formatInput('heating_curve_offset', -5), '-5.00');
  assert.equal(formatInput('heating_curve_offset', 0), '0.00');
  assert.equal(formatInput('heating_curve_offset', 5), '5.00');
});

test('rejects values the firmware would ignore', () => {
  assert.equal(formatInput('dew_point', 35.1), null);
  assert.equal(formatInput('outside_temperature', -41), null);
  assert.equal(formatInput('room_temperature', NaN), null);
  assert.equal(formatInput('room_setpoint', '21'), null);
  assert.equal(formatInput('heating_curve_offset', -5.1), null);
  assert.equal(formatInput('heating_curve_offset', 5.1), null);
  assert.equal(formatInput('unknown_input', 1), null);
});

test('permissions are booleans, not numbers', () => {
  assert.equal(formatInput('heating_enable', true), 'true');
  assert.equal(formatInput('heating_enable', false), 'false');
  assert.equal(formatInput('heating_enable', 1), null);
  assert.equal(formatInput('cooling_enable', true), 'true');
  assert.equal(formatInput('cooling_enable', false), 'false');
  assert.equal(formatInput('cooling_enable', 1), null);
});

test('every input carries both routes to the controller', () => {
  for (const [key, input] of Object.entries(API_INPUTS)) {
    assert.match(input.entity, /^api_input_/, key);
    assert.match(input.topic, /^input\//, key);
  }
});
