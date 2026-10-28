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

test('the heating permission source card sets the select and the picker', async () => {
  const listeners = await runListeners();
  const selects = [];
  const values = {};
  const device = {
    client: { setSelect: async (name, option) => selects.push([name, option]) },
    setCapabilityValue: async (capability, value) => { values[capability] = value; },
    getCapabilityValue: capability => values[capability],
  };

  await listeners.set_heating_enable_source({ device, source: 'disabled' });
  await listeners.set_heating_enable_source({ device, source: 'api_input' });

  assert.deepEqual(selects, [['Heating Enable Source', 'Disabled'], ['Heating Enable Source', 'API input']]);
  assert.equal(await listeners.heating_enable_source_is({ device, source: 'api_input' }), true);
  assert.equal(await listeners.heating_enable_source_is({ device, source: 'ot_thermostat' }), false);
});

test('a heating permission source the controller refused leaves the picker alone', async () => {
  const listeners = await runListeners();
  const values = {};
  const device = {
    client: { setSelect: async () => { throw new Error('HTTP 404 on /select/Heating%20Enable%20Source/set'); } },
    setCapabilityValue: async (capability, value) => { values[capability] = value; },
  };

  await assert.rejects(listeners.set_heating_enable_source({ device, source: 'disabled' }), /HTTP 404/);
  assert.deepEqual(values, {});
});
