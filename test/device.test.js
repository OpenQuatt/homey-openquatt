'use strict';

require('./helpers/require-homey');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const OpenQuattDevice = require('../drivers/openquatt/device');

const ALL_CAPABILITIES = [
  'measure_temperature.supply',
  'measure_temperature.outside',
  'measure_temperature.room',
  'measure_power',
  'onoff.cooling',
  'onoff.aux_relay',
  'oq_control_mode',
  'oq_aux_status',
  'oq_aux_function',
];

// Builds a device around the prototype without running onInit, so the state
// handling can be exercised without a Homey runtime or a live connection.
function makeDevice({ capabilities = ALL_CAPABILITIES } = {}) {
  const device = Object.create(OpenQuattDevice.prototype);
  device._controlModeCode = null;
  device._telemetry = {};
  device._binary = {};
  device._faultActive = null;

  device.triggered = [];
  device.capabilityValues = {};
  device.homey = {
    __: key => key,
    flow: {
      getDeviceTriggerCard: id => ({
        trigger: (dev, tokens) => {
          device.triggered.push({ id, tokens });
          return Promise.resolve();
        },
      }),
    },
  };
  device.hasCapability = cap => capabilities.includes(cap);
  device.setCapabilityValue = (cap, value) => {
    device.capabilityValues[cap] = value;
    return Promise.resolve();
  };
  device.log = () => {};
  device.error = () => {};
  return device;
}

test('maps entity states onto capabilities', () => {
  const device = makeDevice();

  device._onState({ id: 'sensor-total_power_input', value: 250.5, state: '250.5 W' });
  device._onState({ id: 'switch-manual_cooling_enable', value: true, state: 'ON' });
  device._onState({ id: 'text_sensor-control_mode__label_', state: 'Heating (CM2)' });
  device._onState({ id: 'sensor-water_supply_temp__selected_', value: 'NA', state: 'NA' });

  assert.equal(device.capabilityValues.measure_power, 250.5);
  assert.equal(device.capabilityValues['onoff.cooling'], true);
  assert.equal(device.capabilityValues.oq_control_mode, 'Heating (CM2)');
  // Non-numeric sensor values must not reach a numeric capability.
  assert.equal(device.capabilityValues['measure_temperature.supply'], null);
});

test('ignores unknown entities and missing capabilities', () => {
  const device = makeDevice({ capabilities: [] });

  device._onState({ id: 'sensor-something_else', value: 1 });
  device._onState({ id: 'sensor-total_power_input', value: 100 });

  assert.deepEqual(device.capabilityValues, {});
});

test('control mode transitions fire the right triggers once', () => {
  const device = makeDevice();
  const triggeredIds = () => device.triggered.map(t => t.id);

  // First value after connect only records state.
  device._onState({ id: 'text_sensor-control_mode', state: 'CM0' });
  assert.deepEqual(triggeredIds(), []);

  device._onState({ id: 'text_sensor-control_mode', state: 'CM2' });
  assert.deepEqual(triggeredIds(), ['control_mode_changed', 'heating_started']);
  assert.deepEqual(device.triggered[0].tokens, { mode: 'CM2' });

  // CM2 -> CM3 stays inside the heating set: no started/stopped edge.
  device.triggered = [];
  device._onState({ id: 'text_sensor-control_mode', state: 'CM3' });
  assert.deepEqual(triggeredIds(), ['control_mode_changed']);

  // Repeating the same code is not a change.
  device.triggered = [];
  device._onState({ id: 'text_sensor-control_mode', state: 'CM3' });
  assert.deepEqual(triggeredIds(), []);

  device._onState({ id: 'text_sensor-control_mode', state: 'CM5' });
  assert.deepEqual(triggeredIds(), ['control_mode_changed', 'cooling_started', 'heating_stopped']);
  assert.equal(device.isCooling(), true);

  device.triggered = [];
  device._onState({ id: 'text_sensor-control_mode', state: 'CM0' });
  assert.deepEqual(triggeredIds(), ['control_mode_changed', 'cooling_stopped']);
});

test('binary triggers only fire on edges, with their tokens', () => {
  const device = makeDevice();

  // The replay burst after connect records state without triggering.
  device._onState({ id: 'binary_sensor-hp1_-_defrost', value: true, state: 'ON' });
  assert.deepEqual(device.triggered, []);
  assert.equal(device.isDefrosting(), true);

  device._onState({ id: 'binary_sensor-hp1_-_defrost', value: false, state: 'OFF' });
  assert.deepEqual(device.triggered, [
    { id: 'defrost_stopped', tokens: { heatpump: 'HP1' } },
  ]);
  assert.equal(device.isDefrosting(), false);

  device.triggered = [];
  device._onState({ id: 'binary_sensor-boiler_active', value: false, state: 'OFF' });
  device._onState({ id: 'binary_sensor-boiler_active', value: true, state: 'ON' });
  assert.deepEqual(device.triggered, [{ id: 'boiler_started', tokens: {} }]);
  assert.equal(device.isBoilerActive(), true);
});

test('aggregates faults and translates the boolean ones', () => {
  const device = makeDevice();

  device._onState({ id: 'text_sensor-hp1_-_active_failures_list', state: 'None' });
  assert.deepEqual(device.getFaults(), []);
  assert.equal(device.hasFault(), false);

  device._onState({ id: 'text_sensor-hp1_-_active_failures_list', state: 'E042' });
  device._onState({ id: 'binary_sensor-lowflow_fault_active', value: true, state: 'ON' });
  // The homey.__ stub returns the key, so the translated entry is its key.
  assert.deepEqual(device.getFaults(), ['HP1: E042', 'fault.lowflow']);
  assert.equal(device.hasFault(), true);
});

test('fault triggers wait for the baseline and fire on transitions', () => {
  const device = makeDevice();

  // Before the settle window establishes a baseline, fault changes stay quiet.
  device._onState({ id: 'text_sensor-hp1_-_active_failures_list', state: 'E042' });
  assert.deepEqual(device.triggered, []);

  // Baseline established (no faults), then a fault appears and resolves.
  device._telemetry = {};
  device._faultActive = false;
  device._onState({ id: 'text_sensor-hp1_-_active_failures_list', state: 'E042' });
  device._onState({ id: 'binary_sensor-ot_-_link_problem', value: true, state: 'ON' });
  device._onState({ id: 'text_sensor-hp1_-_active_failures_list', state: 'None' });
  device._onState({ id: 'binary_sensor-ot_-_link_problem', value: false, state: 'OFF' });

  assert.deepEqual(device.triggered, [
    { id: 'fault_detected', tokens: { fault: 'HP1: E042' } },
    { id: 'fault_resolved', tokens: undefined },
  ]);
});

test('getTelemetry exposes widget data including the control mode code', () => {
  const device = makeDevice();

  device._onState({ id: 'text_sensor-control_mode', state: 'CM2' });
  device._onState({ id: 'sensor-total_heat_power', value: 4.2, state: '4.2 kW' });
  device._onState({ id: 'sensor-heatpump_cop_daily', value: 'NA', state: 'NA' });

  assert.deepEqual(device.getTelemetry(), {
    controlModeCode: 'CM2',
    heatPower: 4.2,
    copDaily: null,
  });
});

// --- Dew point delivery ---------------------------------------------------

const { DewPointSources } = require('../lib/dewPoint');

// Device with just enough wiring to exercise setDewPoint / _deliverDewPoint.
function makeDewPointDevice({ apiFails = false, publisher = null } = {}) {
  const device = makeDevice();
  device._dewPointSources = new DewPointSources();
  device.getSetting = () => 60;
  device.apiCalls = [];
  device.client = {
    setNumber: (name, value) => {
      device.apiCalls.push({ name, value });
      return apiFails ? Promise.reject(new Error('HTTP 404 on /number')) : Promise.resolve();
    },
  };
  device._publisher = publisher;
  return device;
}

test('setDewPoint delivers via the API input', async () => {
  const device = makeDewPointDevice();

  await device.setDewPoint('flow', 16.77);

  assert.deepEqual(device.apiCalls, [
    { name: 'api_input_cooling_dew_point', value: '16.77' },
  ]);
});

test('setDewPoint falls back to MQTT when the API input is missing', async () => {
  const published = [];
  const device = makeDewPointDevice({
    apiFails: true,
    publisher: {
      publish: (topic, payload) => {
        published.push({ topic, payload });
        return true;
      },
    },
  });
  device._dewPointTopic = 'openquatt/openquatt/input/cooling/dew_point';

  await device.setDewPoint('room:test', 12.3);

  assert.deepEqual(published, [
    { topic: 'openquatt/openquatt/input/cooling/dew_point', payload: '12.30' },
  ]);
});

test('setDewPoint rejects when no route accepts the value', async () => {
  const device = makeDewPointDevice({ apiFails: true });

  await assert.rejects(device.setDewPoint('flow', 12.3), /delivery_failed/);
});

test('setDewPoint rejects out-of-range values without delivering', async () => {
  const device = makeDewPointDevice();

  await assert.rejects(device.setDewPoint('flow', 40), /out_of_range/);
  await assert.rejects(device.setDewPoint('flow', NaN), /out_of_range/);
  assert.equal(device.apiCalls.length, 0);
});

test('the highest fresh room wins the delivered aggregate', async () => {
  const device = makeDewPointDevice();

  await device.setDewPoint('room:a', 12);
  await device.setDewPoint('room:b', 15.5);
  await device.setDewPoint('room:a', 11);

  assert.equal(device.apiCalls[device.apiCalls.length - 1].value, '15.50');
});
