'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ID_TO_OPTION, OPTION_TO_ID } = require('../lib/auxFunctions');

test('every id maps to a unique option and back', () => {
  for (const [id, option] of Object.entries(ID_TO_OPTION)) {
    assert.equal(OPTION_TO_ID[option], id);
  }
  assert.equal(
    Object.keys(ID_TO_OPTION).length,
    Object.keys(OPTION_TO_ID).length,
  );
});

test('covers the firmware options for the aux relay select', () => {
  assert.deepEqual(Object.values(ID_TO_OPTION).sort(), [
    'Cooling demand',
    'Disabled',
    'External control',
    'Heating demand',
    'Heating or cooling demand',
  ]);
});
