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

test('the room temperature source card sets only that select and the picker', async () => {
  const listeners = await runListeners();
  const selects = [];
  const values = {};
  const device = {
    client: { setSelect: async (name, option) => selects.push([name, option]) },
    setCapabilityValue: async (capability, value) => { values[capability] = value; },
    getCapabilityValue: capability => values[capability],
  };

  await listeners.set_room_temperature_source({ device, source: 'api_input' });

  assert.deepEqual(selects, [['Room Temperature Source', 'API input']]);
  assert.deepEqual(Object.keys(values), ['oq_room_temperature_source']);
  assert.equal(await listeners.room_temperature_source_is({ device, source: 'api_input' }), true);
  assert.equal(await listeners.room_temperature_source_is({ device, source: 'ot_thermostat' }), false);
});

test('the aux relay hysteresis card goes through the device', async () => {
  const listeners = await runListeners();
  const set = [];
  const device = { setAuxHysteresis: async value => set.push(value) };

  await listeners.set_aux_hysteresis({ device, hysteresis: 3 });

  assert.deepEqual(set, [3]);
});

test('the heating strategy cards switch through the device and read the picker', async () => {
  const listeners = await runListeners();
  const switched = [];
  const values = { oq_heating_strategy: 'heating_curve' };
  const device = {
    setHeatingStrategy: async strategy => switched.push(strategy),
    getCapabilityValue: capability => values[capability],
  };

  await listeners.set_heating_strategy({ device, strategy: 'power_house' });

  assert.deepEqual(switched, ['power_house']);
  assert.equal(await listeners.heating_strategy_is({ device, strategy: 'heating_curve' }), true);
  assert.equal(await listeners.heating_strategy_is({ device, strategy: 'power_house' }), false);
});

test('the extended heating card writes both thresholds before the switch', async () => {
  const listeners = await runListeners();
  const calls = [];
  const device = {
    client: {
      setNumber: async (name, value) => calls.push(['number', name, value]),
      setSwitch: async (name, on) => calls.push(['switch', name, on]),
    },
  };

  await listeners.set_run_extension({
    device, state: 'on', margin: 1, cooldown: 1.1,
  });
  await listeners.set_run_extension({
    device, state: 'off', margin: 0.5, cooldown: 0.2,
  });

  assert.deepEqual(calls, [
    ['number', 'Power House run extension stop margin', 1],
    ['number', 'Power House run extension restart cooldown', 1.1],
    ['switch', 'Power House run extension', true],
    ['number', 'Power House run extension stop margin', 0.5],
    ['number', 'Power House run extension restart cooldown', 0.2],
    ['switch', 'Power House run extension', false],
  ]);
});

test('a refused threshold leaves extended heating untouched', async () => {
  const listeners = await runListeners();
  const switched = [];
  const device = {
    client: {
      setNumber: async () => { throw new Error('HTTP 404 on /number/Power%20House%20run%20extension%20stop%20margin/set'); },
      setSwitch: async (name, on) => switched.push(on),
    },
  };

  await assert.rejects(listeners.set_run_extension({
    device, state: 'on', margin: 1, cooldown: 1.1,
  }), /HTTP 404/);
  assert.deepEqual(switched, []);
});
