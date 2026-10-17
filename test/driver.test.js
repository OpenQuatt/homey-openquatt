'use strict';

require('./helpers/require-homey');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const OpenQuattDriver = require('../drivers/openquatt/driver');

// Runs onInit against a flow stub and returns the registered run listeners by
// card id.
async function runListeners() {
  const listeners = {};
  const card = id => ({
    registerRunListener: fn => {
      listeners[id] = fn;
    },
  });
  const driver = Object.create(OpenQuattDriver.prototype);
  driver.homey = {
    __: key => key,
    flow: { getConditionCard: card, getActionCard: card, getDeviceTriggerCard: card },
  };
  await driver.onInit();
  return listeners;
}

test('the flow threshold triggers fire only on the reading that crosses', async () => {
  const listeners = await runListeners();
  const rose = (threshold, previous, current) => listeners.flow_rose_above({ threshold }, { previous, current });
  const dropped = (threshold, previous, current) => listeners.flow_dropped_below({ threshold }, { previous, current });

  assert.equal(await rose(500, 400, 600), true);
  assert.equal(await rose(500, 500, 501), true);
  assert.equal(await rose(500, 600, 700), false);
  assert.equal(await rose(500, 400, 500), false);
  assert.equal(await rose(500, 600, 400), false);

  assert.equal(await dropped(300, 400, 200), true);
  assert.equal(await dropped(300, 300, 299), true);
  assert.equal(await dropped(300, 200, 100), false);
  assert.equal(await dropped(300, 400, 300), false);
  assert.equal(await dropped(300, 200, 400), false);
});

test('the flow condition compares against the current flow', async () => {
  const listeners = await runListeners();
  const isAbove = (flow, threshold) => listeners.flow_is_above({
    device: { getCapabilityValue: () => flow },
    threshold,
  });

  assert.equal(await isAbove(600, 500), true);
  assert.equal(await isAbove(500, 500), false);
  assert.equal(await isAbove(400, 500), false);
  // An unknown flow is not above anything.
  assert.equal(await isAbove(null, 0), false);
});
