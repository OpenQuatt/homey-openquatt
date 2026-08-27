'use strict';

require('./helpers/require-homey');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const OpenQuattDevice = require('../drivers/openquatt/device');

const ALL_CAPABILITIES = [
  'measure_temperature.supply',
  'measure_temperature.outside',
  'measure_temperature.room',
  'measure_temperature.setpoint',
  'measure_power',
  'oq_heat_power',
  'oq_cool_power',
  'oq_cop',
  'oq_eer',
  'oq_flow',
  'oq_heating_permitted',
  'oq_cooling_permitted',
  'onoff.openquatt',
  'onoff.cooling',
  'onoff.aux_relay',
  'oq_control_mode',
  'oq_control_mode_number',
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

test('maps the Insights entities onto their capabilities', () => {
  const device = makeDevice();

  device._onState({ id: 'sensor-total_cop', value: 4.12, state: '4.12' });
  device._onState({ id: 'sensor-flow_average__selected_', value: 780, state: '780 L/h' });
  device._onState({ id: 'sensor-room_setpoint__selected_', value: 20.5, state: '20.5 °C' });
  device._onState({ id: 'binary_sensor-heating_enable__selected_', value: true, state: 'ON' });
  device._onState({ id: 'binary_sensor-cooling_enable__selected_', value: false, state: 'OFF' });
  device._onState({ id: 'switch-openquatt_enabled', value: true, state: 'ON' });

  assert.equal(device.capabilityValues.oq_cop, 4.12);
  assert.equal(device.capabilityValues.oq_flow, 780);
  assert.equal(device.capabilityValues['measure_temperature.setpoint'], 20.5);
  assert.equal(device.capabilityValues.oq_heating_permitted, true);
  assert.equal(device.capabilityValues.oq_cooling_permitted, false);
  assert.equal(device.capabilityValues['onoff.openquatt'], true);
});

test('thermal power feeds both the widget and its capability', () => {
  const device = makeDevice();

  device._onState({ id: 'sensor-total_heat_power', value: 4200, state: '4200 W' });
  device._onState({ id: 'sensor-total_cooling_power', value: 'NA', state: 'NA' });

  assert.equal(device.getTelemetry().heatPower, 4200);
  assert.equal(device.capabilityValues.oq_heat_power, 4200);
  assert.equal(device.capabilityValues.oq_cool_power, null);
});

test('the control mode is logged as a number as well as a label', () => {
  const device = makeDevice();

  device._onState({ id: 'text_sensor-control_mode', state: 'CM2' });
  assert.equal(device.capabilityValues.oq_control_mode_number, 2);

  device._onState({ id: 'text_sensor-control_mode', state: 'CM98' });
  assert.equal(device.capabilityValues.oq_control_mode_number, 98);

  // A mode that is not a CM code leaves nothing to graph.
  device._onState({ id: 'text_sensor-control_mode', state: 'Unknown' });
  assert.equal(device.capabilityValues.oq_control_mode_number, null);
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

// --- Feeding external source values ---------------------------------------

const { DewPointSources } = require('../lib/dewPoint');

// Device with just enough wiring to exercise setDewPoint / setInput / _deliver.
function makeFeedDevice({ apiFails = false, publisher = null } = {}) {
  const device = makeDevice();
  device._dewPointSources = new DewPointSources();
  device._inputs = {};
  device._deliveryProblems = {};
  device.getSetting = () => 60;
  device.apiCalls = [];
  device.stored = null;
  const call = (route, name, value) => {
    device.apiCalls.push({ route, name, value });
    return apiFails ? Promise.reject(new Error('HTTP 404 on /number')) : Promise.resolve();
  };
  device.client = {
    setNumber: (name, value) => call('number', name, value),
    setSwitch: (name, value) => call('switch', name, value),
  };
  device._publisher = publisher;
  device._topicPrefix = 'openquatt/openquatt/';
  device.getStoreValue = () => device.stored;
  device.setStoreValue = (key, value) => {
    device.stored = value;
    return Promise.resolve();
  };
  return device;
}

test('setDewPoint delivers via the API input', async () => {
  const device = makeFeedDevice();

  await device.setDewPoint('flow', 16.77);

  assert.deepEqual(device.apiCalls, [
    { route: 'number', name: 'api_input_cooling_dew_point', value: '16.77' },
  ]);
});

test('setDewPoint falls back to MQTT when the API input is missing', async () => {
  const published = [];
  const device = makeFeedDevice({
    apiFails: true,
    publisher: {
      publish: (topic, payload) => {
        published.push({ topic, payload });
        return true;
      },
    },
  });

  await device.setDewPoint('room:test', 12.3);

  assert.deepEqual(published, [
    { topic: 'openquatt/openquatt/input/cooling/dew_point', payload: '12.30' },
  ]);
});

test('setDewPoint rejects when no route accepts the value', async () => {
  const device = makeFeedDevice({ apiFails: true });

  await assert.rejects(device.setDewPoint('flow', 12.3), /delivery_failed/);
});

test('setDewPoint rejects out-of-range values without delivering', async () => {
  const device = makeFeedDevice();

  await assert.rejects(device.setDewPoint('flow', 40), /out_of_range/);
  await assert.rejects(device.setDewPoint('flow', NaN), /out_of_range/);
  assert.equal(device.apiCalls.length, 0);
});

test('the highest fresh room wins the delivered aggregate', async () => {
  const device = makeFeedDevice();

  await device.setDewPoint('room:a', 12);
  await device.setDewPoint('room:b', 15.5);
  await device.setDewPoint('room:a', 11);

  assert.equal(device.apiCalls[device.apiCalls.length - 1].value, '15.50');
});

test('setInput sends temperatures to their own API input', async () => {
  const device = makeFeedDevice();

  await device.setInput('outside_temperature', 7.2);
  await device.setInput('room_temperature', 20.5);
  await device.setInput('room_setpoint', 21);

  assert.deepEqual(device.apiCalls, [
    { route: 'number', name: 'api_input_outside_temperature', value: '7.20' },
    { route: 'number', name: 'api_input_room_temperature', value: '20.50' },
    { route: 'number', name: 'api_input_room_setpoint', value: '21.00' },
  ]);
});

test('the permissions take the switch route, MQTT as boolean', async () => {
  const published = [];
  const device = makeFeedDevice({
    publisher: { publish: (topic, payload) => published.push({ topic, payload }) && true },
  });

  await device.setInput('heating_enable', false);
  await device.setInput('cooling_enable', true);

  assert.deepEqual(device.apiCalls, [
    { route: 'switch', name: 'api_input_heating_enable', value: false },
    { route: 'switch', name: 'api_input_cooling_enable', value: true },
  ]);
  assert.deepEqual(published, [
    { topic: 'openquatt/openquatt/input/thermostat/heating_enable', payload: 'false' },
    { topic: 'openquatt/openquatt/input/thermostat/cooling_enable', payload: 'true' },
  ]);
});

test('setInput rejects values the firmware would ignore', async () => {
  const device = makeFeedDevice();

  await assert.rejects(device.setInput('room_setpoint', 3), /out_of_range/);
  await assert.rejects(device.setInput('outside_temperature', 61), /out_of_range/);
  await assert.rejects(device.setInput('room_temperature', 'warm'), /out_of_range/);
  assert.equal(device.apiCalls.length, 0);
});

test('commands are stored and restored, measurements are not', async () => {
  const device = makeFeedDevice();

  await device.setInput('room_temperature', 20.5);
  await device.setInput('room_setpoint', 21);
  await device.setInput('heating_enable', true);
  await device.setInput('cooling_enable', false);

  assert.deepEqual(device.stored, {
    room_setpoint: 21, heating_enable: true, cooling_enable: false,
  });
  assert.deepEqual(device._restoreInputs(), {
    room_setpoint: { value: 21, updatedAt: device._inputs.room_setpoint.updatedAt },
    heating_enable: { value: true, updatedAt: device._inputs.heating_enable.updatedAt },
    cooling_enable: { value: false, updatedAt: device._inputs.cooling_enable.updatedAt },
  });
});

test('the publish loop drops stale measurements but keeps commands standing', async () => {
  const device = makeFeedDevice();
  const stale = Date.now() - (61 * 60 * 1000);
  device._inputs = {
    outside_temperature: { value: 7.2, updatedAt: stale },
    room_setpoint: { value: 21, updatedAt: stale },
  };

  await device._publishInputs();

  assert.deepEqual(device.apiCalls, [
    { route: 'number', name: 'api_input_room_setpoint', value: '21.00' },
  ]);
  assert.deepEqual(Object.keys(device._inputs), ['room_setpoint']);
});

test('the publish loop re-sends the dew point aggregate alongside the inputs', async () => {
  const device = makeFeedDevice();

  device._dewPointSources.update('room:a', 14, Date.now());
  device._inputs = { room_temperature: { value: 20.5, updatedAt: Date.now() } };

  await device._publishInputs();

  assert.deepEqual(device.apiCalls, [
    { route: 'number', name: 'api_input_cooling_dew_point', value: '14.00' },
    { route: 'number', name: 'api_input_room_temperature', value: '20.50' },
  ]);
});
