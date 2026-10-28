'use strict';

require('./helpers/require-homey');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const EventEmitter = require('node:events');

const OpenQuattDevice = require('../drivers/openquatt/device');
const { History } = require('../lib/History');

const ALL_CAPABILITIES = [
  'measure_temperature.supply',
  'measure_temperature.return',
  'measure_temperature.supply_target',
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
  'oq_heating_enable_source',
  'oq_heating_strategy',
];

// Builds a device around the prototype without running onInit, so the state
// handling can be exercised without a Homey runtime or a live connection.
function makeDevice({ capabilities: initial = ALL_CAPABILITIES } = {}) {
  // A copy, as capabilities may be added along the way.
  const capabilities = [...initial];
  const device = Object.create(OpenQuattDevice.prototype);
  device._controlModeCode = null;
  device._telemetry = {};
  device._heatpumps = {};
  device._binary = {};
  device._numeric = {};
  device._entities = {};
  device._faultActive = null;

  device.triggered = [];
  device.capabilityValues = {};
  device.homey = {
    __: key => key,
    flow: {
      getDeviceTriggerCard: id => ({
        trigger: (dev, tokens, state) => {
          device.triggered.push(state === undefined ? { id, tokens } : { id, tokens, state });
          return Promise.resolve();
        },
      }),
    },
  };
  device.hasCapability = cap => capabilities.includes(cap);
  device.getCapabilities = () => capabilities;
  device.addCapability = cap => {
    capabilities.push(cap);
    return Promise.resolve();
  };
  device.getName = () => 'OpenQuatt';
  device.getAvailable = () => true;
  device.getCapabilityValue = cap => (cap in device.capabilityValues ? device.capabilityValues[cap] : null);
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
  device._onState({ id: 'sensor-hp1_-_water_in_temperature', value: 27.84, state: '27.84 °C' });
  device._onState({ id: 'sensor-heating_supply_target__effective_', value: 34.5, state: '34.5 °C' });

  assert.equal(device.capabilityValues.oq_cop, 4.12);
  assert.equal(device.capabilityValues.oq_flow, 780);
  assert.equal(device.capabilityValues['measure_temperature.setpoint'], 20.5);
  assert.equal(device.capabilityValues.oq_heating_permitted, true);
  assert.equal(device.capabilityValues.oq_cooling_permitted, false);
  assert.equal(device.capabilityValues['onoff.openquatt'], true);
  assert.equal(device.capabilityValues['measure_temperature.return'], 27.84);
  assert.equal(device.capabilityValues['measure_temperature.supply_target'], 34.5);
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

test('the heating permission source maps onto its picker', () => {
  const device = makeDevice();

  device._onState({ id: 'select-heating_enable_source', state: 'OT thermostat', value: 1 });
  assert.equal(device.capabilityValues.oq_heating_enable_source, 'ot_thermostat');

  device._onState({ id: 'select-heating_enable_source', state: 'Disabled', value: 0 });
  assert.equal(device.capabilityValues.oq_heating_enable_source, 'disabled');

  device._onState({ id: 'select-heating_enable_source', state: 'API input', value: 4 });
  assert.equal(device.capabilityValues.oq_heating_enable_source, 'api_input');

  // An option from newer firmware leaves the picker empty instead of wrong.
  device._onState({ id: 'select-heating_enable_source', state: 'Zone controller', value: 6 });
  assert.equal(device.capabilityValues.oq_heating_enable_source, null);
});

test('the heating strategy maps onto its picker', () => {
  const device = makeDevice();

  device._onState({ id: 'select-heating_control_mode', state: 'Power House', value: 0 });
  assert.equal(device.capabilityValues.oq_heating_strategy, 'power_house');

  device._onState({ id: 'select-heating_control_mode', state: 'Water Temperature Control (heating curve)', value: 1 });
  assert.equal(device.capabilityValues.oq_heating_strategy, 'heating_curve');

  device._onState({ id: 'select-heating_control_mode', state: 'Zone control', value: 2 });
  assert.equal(device.capabilityValues.oq_heating_strategy, null);
});

// A client that records each select it is sent and, unless told otherwise,
// reports it back on the event stream through the device, as the firmware
// does. Timers are held so a test can expire them.
function strategyDevice({ report = true, fail = null } = {}) {
  const device = makeDevice();
  const client = new EventEmitter();
  client.selects = [];
  client.setSelect = async (name, option) => {
    if (fail) throw fail;
    client.selects.push([name, option]);
    if (report) client.emit('state', { id: 'select-heating_control_mode', state: option });
  };
  client.on('state', state => device._onState(state));
  device.client = client;
  device.timers = [];
  device.homey.setTimeout = (fn, ms) => {
    const timer = { fn, ms, cleared: false };
    device.timers.push(timer);
    return timer;
  };
  device.homey.clearTimeout = timer => { timer.cleared = true; };
  return device;
}

test('switching the heating strategy sends only that select and waits for the stream', async () => {
  const device = strategyDevice();
  device._onState({ id: 'select-heating_enable_source', state: 'Disabled', value: 0 });
  device._onState({ id: 'select-heating_control_mode', state: 'Water Temperature Control (heating curve)', value: 1 });

  await device.setHeatingStrategy('power_house');
  assert.deepEqual(device.client.selects, [['Heating Control Mode', 'Power House']]);
  assert.equal(device.capabilityValues.oq_heating_strategy, 'power_house');

  await device.setHeatingStrategy('heating_curve');
  assert.deepEqual(device.client.selects, [
    ['Heating Control Mode', 'Power House'],
    ['Heating Control Mode', 'Water Temperature Control (heating curve)'],
  ]);
  // The permission source is never part of a strategy switch.
  assert.equal(device.capabilityValues.oq_heating_enable_source, 'disabled');
  assert.ok(device.timers.every(timer => timer.cleared));
  assert.equal(device.client.listenerCount('state'), 1);
});

test('asking for the running heating strategy sends nothing', async () => {
  const device = strategyDevice();
  device._onState({ id: 'select-heating_control_mode', state: 'Power House', value: 0 });

  await device.setHeatingStrategy('power_house');
  assert.deepEqual(device.client.selects, []);
});

test('a heating strategy switch the stream does not report fails after the timeout', async () => {
  const device = strategyDevice({ report: false });
  device._onState({ id: 'select-heating_control_mode', state: 'Power House', value: 0 });

  const switching = device.setHeatingStrategy('heating_curve');
  await new Promise(setImmediate);
  assert.equal(device.timers.length, 1);
  assert.equal(device.timers[0].ms, 15000);
  device.timers[0].fn();

  await assert.rejects(switching, /strategy.not_confirmed/);
  assert.equal(device.client.listenerCount('state'), 1);
});

test('a heating strategy the controller refused rejects and stops waiting', async () => {
  const device = strategyDevice({ fail: new Error('HTTP 404 on /select/Heating%20Control%20Mode/set') });

  await assert.rejects(device.setHeatingStrategy('power_house'), /HTTP 404/);
  assert.ok(device.timers.every(timer => timer.cleared));
  assert.equal(device.client.listenerCount('state'), 1);
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

test('flow triggers fire on whole-number changes, with previous and current', () => {
  const device = makeDevice();
  const flow = value => device._onState({ id: 'sensor-flow_average__selected_', value, state: `${value} L/h` });
  const cards = (tokens, state) => ['flow_changed', 'flow_rose_above', 'flow_dropped_below']
    .map(id => ({ id, tokens, state }));

  // The first reading only records state.
  flow(812.4);
  assert.deepEqual(device.triggered, []);
  assert.equal(device.capabilityValues.oq_flow, 812.4);

  // Noise below the shown precision fires nothing.
  flow(811.6);
  assert.deepEqual(device.triggered, []);

  flow(640.2);
  assert.deepEqual(device.triggered, cards({ flow: 640 }, { previous: 812, current: 640 }));

  // A dropout is skipped, not a drop to zero; the next reading compares
  // against the last real one.
  device.triggered = [];
  flow('NA');
  assert.deepEqual(device.triggered, []);
  flow(655);
  assert.deepEqual(device.triggered, cards({ flow: 655 }, { previous: 640, current: 655 }));
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

test('getHeatpump keeps each unit apart, and has nothing for an absent HP2', () => {
  const device = makeDevice();

  device._onState({ id: 'text_sensor-hp1_-_working_mode_label', state: 'Heating' });
  device._onState({ id: 'sensor-hp1_-_compressor_frequency', value: 52, state: '52 Hz' });
  device._onState({ id: 'sensor-hp1_-_fan_speed', value: 640, state: '640 rpm' });
  device._onState({ id: 'sensor-hp1_-_cop', value: 'NA', state: 'NA' });
  device._onState({ id: 'sensor-hp1_-_water_in_temperature', value: 30.1, state: '30.1 °C' });
  device._onState({ id: 'binary_sensor-hp1_-_defrost', value: false, state: 'OFF' });
  device._onState({ id: 'text_sensor-hp1_-_active_failures_list', state: 'None' });
  // Same name without the unit prefix: a system entity, not part of a unit.
  device._onState({ id: 'sensor-flow', value: 999, state: '999 L/h' });

  assert.deepEqual(device.getHeatpump('hp1'), {
    mode: 'Heating',
    frequency: 52,
    fanSpeed: 640,
    cop: null,
    waterIn: 30.1,
    defrost: false,
    failures: 'None',
  });
  assert.equal(device.getHeatpump('hp2'), null);
  // The unit entities keep feeding their capability and the fault state.
  assert.equal(device.capabilityValues['measure_temperature.return'], 30.1);
  assert.equal(device.getTelemetry().hp1Failures, 'None');

  device._onState({ id: 'sensor-hp2_-_power_input', value: 812.5, state: '812.5 W' });
  assert.deepEqual(device.getHeatpump('hp2'), { power: 812.5 });
  assert.equal(device.getHeatpump('hp1').power, undefined);
});

test('unit defrost feeds the widget and still fires its trigger', () => {
  const device = makeDevice();

  device._onState({ id: 'binary_sensor-hp2_-_defrost', value: false, state: 'OFF' });
  device._onState({ id: 'binary_sensor-hp2_-_defrost', value: true, state: 'ON' });

  assert.equal(device.getHeatpump('hp2').defrost, true);
  assert.deepEqual(device.triggered, [{ id: 'defrost_started', tokens: { heatpump: 'HP2' } }]);
});

test('HP1 of a Quatt Hybrid V1 shows the selected flow', () => {
  const device = makeDevice();

  device._onState({ id: 'sensor-hp1_-_flow', value: 0, state: '0 L/h' });
  device._onState({ id: 'sensor-hp2_-_flow', value: 410, state: '410 L/h' });
  device._onState({ id: 'sensor-flow_average__selected_', value: 780, state: '780 L/h' });
  assert.equal(device.getHeatpump('hp1').flow, 0);

  device._onState({ id: 'select-quatt_hybrid_version', state: 'V1', value: 'V1' });
  assert.equal(device.getHeatpump('hp1').flow, 780);
  assert.equal(device.getHeatpump('hp2').flow, 410);
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

test('heating curve offset uses API and MQTT, and stands without being stored', async () => {
  const published = [];
  const device = makeFeedDevice({
    publisher: {
      publish: (topic, payload) => {
        published.push({ topic, payload });
        return true;
      },
    },
  });

  await device.setInput('heating_curve_offset', -1.5);
  assert.deepEqual(device.apiCalls, [
    { route: 'number', name: 'api_input_heating_curve_modifier', value: '-1.50' },
  ]);
  assert.deepEqual(published, [
    { topic: 'openquatt/openquatt/input/heating/curve_modifier', payload: '-1.50' },
  ]);
  assert.equal(device.stored, null);

  // A command, not a measurement: it outlives the sensor age.
  device._inputs.heating_curve_offset.updatedAt -= 61 * 60 * 1000;
  await device._publishInputs();
  assert.equal(device._inputs.heating_curve_offset.value, -1.5);
  assert.equal(device.apiCalls.length, 2);
  assert.equal(published.length, 2);
});

test('a heating curve offset that failed to deliver is retried on the next tick', async () => {
  const device = makeFeedDevice({ apiFails: true });

  await assert.rejects(device.setInput('heating_curve_offset', 3), /delivery_failed/);
  assert.equal(device._inputs.heating_curve_offset.value, 3);

  await device._publishInputs();
  assert.deepEqual(device.apiCalls.map(call => call.value), ['3.00', '3.00']);
});

test('the supply target uses API and MQTT, and stands without being stored', async () => {
  const published = [];
  const device = makeFeedDevice({
    publisher: {
      publish: (topic, payload) => {
        published.push({ topic, payload });
        return true;
      },
    },
  });

  await device.setInput('heating_supply_target', 42);
  assert.deepEqual(device.apiCalls, [
    { route: 'number', name: 'api_input_heating_supply_target', value: '42.00' },
  ]);
  assert.deepEqual(published, [
    { topic: 'openquatt/openquatt/input/heating/supply_target', payload: '42.00' },
  ]);
  assert.equal(device.stored, null);

  // A command, not a measurement: it outlives the sensor age.
  device._inputs.heating_supply_target.updatedAt -= 61 * 60 * 1000;
  await device._publishInputs();
  assert.equal(device._inputs.heating_supply_target.value, 42);
  assert.equal(device.apiCalls.length, 2);
});

test('a released supply target is no longer re-sent', async () => {
  const device = makeFeedDevice();

  await device.setInput('heating_supply_target', 42);
  device.releaseInput('heating_supply_target');
  await device._publishInputs();

  assert.equal(device._inputs.heating_supply_target, undefined);
  assert.equal(device.apiCalls.length, 1);
  // Releasing what was never sent is harmless.
  device.releaseInput('heating_supply_target');
});

test('setInput rejects a supply target outside the heating range', async () => {
  const device = makeFeedDevice();

  await assert.rejects(device.setInput('heating_supply_target', 15), /out_of_range/);
  await assert.rejects(device.setInput('heating_supply_target', 75), /out_of_range/);
  assert.equal(device.apiCalls.length, 0);
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
  // Restored entries are stamped at restore time, so compare the values only:
  // matching timestamps would fail whenever a millisecond passes in between.
  const restored = device._restoreInputs();
  assert.deepEqual(
    Object.fromEntries(Object.entries(restored).map(([key, entry]) => [key, entry.value])),
    { room_setpoint: 21, heating_enable: true, cooling_enable: false },
  );
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

test('the remote snapshot carries the device data, and every entity on request', () => {
  const device = makeDevice();
  device.getName = () => 'OpenQuatt';
  device.getAvailable = () => true;

  device._onState({
    id: 'sensor-total_power_input', name: 'Total Power Input', value: 250.5, state: '250.5 W',
  });
  device._onState({ id: 'sensor-hp1_-_compressor_frequency', value: 42, state: '42 Hz' });
  device._onState({ id: 'text_sensor-control_mode', value: 'CM2', state: 'CM2' });
  device._onState({
    id: 'sensor-total_power_input', name: 'Total Power Input', value: 300, state: '300.0 W',
  });

  const snapshot = device.getRemoteSnapshot();
  assert.equal(snapshot.name, 'OpenQuatt');
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.capabilities.measure_power, 300);
  assert.equal(snapshot.capabilities['measure_temperature.supply'], null);
  assert.equal(snapshot.telemetry.controlModeCode, 'CM2');
  assert.equal(snapshot.heatpumps.hp1.frequency, 42);
  assert.equal(snapshot.heatpumps.hp2, null);
  assert.equal(snapshot.entities, undefined);

  // Latest value per entity, typed and as the firmware formats it; v2 frames
  // have no name.
  assert.deepEqual(device.getRemoteSnapshot({ entities: true }).entities, [
    {
      id: 'sensor-total_power_input', name: 'Total Power Input', state: '300.0 W', value: 300,
    },
    {
      id: 'sensor-hp1_-_compressor_frequency', name: null, state: '42 Hz', value: 42,
    },
    {
      id: 'text_sensor-control_mode', name: null, state: 'CM2', value: 'CM2',
    },
  ]);

  // Or only the ones asked for; unknown ids are left out.
  assert.deepEqual(
    device.getRemoteSnapshot({ entities: ['text_sensor-control_mode', 'sensor-nope'] }).entities,
    [{
      id: 'text_sensor-control_mode', name: null, state: 'CM2', value: 'CM2',
    }],
  );
});

test('settings refuse remote access without a strong login, and pass the login on', async () => {
  const device = makeDevice();
  const logins = [];
  device.client = { setHost() {}, setCredentials: login => logins.push(login) };
  const settings = {
    address: '', web_username: 'admin', web_password: 'short', remote_enabled: true,
  };

  await assert.rejects(device.onSettings({ newSettings: settings, changedKeys: ['remote_enabled'] }), /remote\.login_required/);
  await assert.rejects(device.onSettings({ newSettings: { ...settings, web_username: '', web_password: 'correct-horse' }, changedKeys: [] }));
  assert.deepEqual(logins, []);

  await device.onSettings({ newSettings: { ...settings, web_password: 'correct-horse' }, changedKeys: ['web_password'] });
  await device.onSettings({ newSettings: { ...settings, remote_enabled: false }, changedKeys: ['remote_enabled'] });
  assert.deepEqual(logins, [
    { username: 'admin', password: 'correct-horse' },
    { username: 'admin', password: 'short' },
  ]);
});

test('a device paired as a thermostat becomes a heat pump', async () => {
  const device = makeDevice();
  let deviceClass = 'thermostat';
  device.getClass = () => deviceClass;
  device.setClass = value => {
    deviceClass = value;
    return Promise.resolve();
  };

  await device._migrateClass();
  assert.equal(deviceClass, 'heatpump');

  // Already a heat pump: nothing to set.
  device.setClass = () => assert.fail('setClass called again');
  await device._migrateClass();
});

test('history records only while connected, from the capabilities and units', () => {
  const device = makeDevice();
  let available = true;
  device.getAvailable = () => available;
  device._history = new History({
    fields: [['supply', 1], ['power', 0], ['hp1', 0], ['hp2', 0]],
    intervalMs: 300000,
    spanMs: 86400000,
  });

  device._onState({ id: 'sensor-water_supply_temp__selected_', value: 44.86, state: '44.86 °C' });
  device._onState({ id: 'sensor-total_power_input', value: 512.4, state: '512.4 W' });
  device._onState({ id: 'sensor-hp1_-_compressor_frequency', value: 48, state: '48 Hz' });
  device._recordHistory();
  available = false;
  device._onState({ id: 'sensor-total_power_input', value: 9999, state: '9999 W' });
  device._recordHistory();

  const { fields, rows } = device.getRemoteHistory();
  assert.deepEqual(fields, ['supply', 'power', 'hp1', 'hp2']);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].slice(1), [44.9, 512, 48, null]);
});

test('energy history is parsed, and cached briefly per range', async () => {
  const device = makeDevice();
  device._energyCache = new Map();
  const paths = [];
  device.client = {
    getText: async path => {
      paths.push(path);
      return '@schema|3\n3|20261018|0|8168|7534|0|32623|0|0|32584\n@current|20261019|2642|2418|0|10211|0|0|10221\n';
    },
  };

  const range = { from: 20261018, to: 20261019, hours: false };
  const first = await device.getEnergyHistory(range);
  assert.deepEqual(first.days.map(day => [day.date, day.electrical]), [[20261018, 8168], [20261019, 2642]]);
  await device.getEnergyHistory(range);
  assert.deepEqual(paths, ['/energy/history?from=20261018&to=20261019&hours=0']);

  await device.getEnergyHistory({ ...range, hours: true });
  assert.equal(paths[1], '/energy/history?from=20261018&to=20261019&hours=1');
});

test('number entities carry a numeric value', () => {
  const device = makeDevice();
  device._onState({ id: 'number-minimum_runtime', value: '300', state: '300 s' });
  device._onState({ id: 'number-unset', value: '', state: 'NA' });
  const { entities } = device.getRemoteSnapshot({ entities: ['number-minimum_runtime', 'number-unset'] });
  assert.deepEqual(entities.map(entity => entity.value), [300, null]);
});

test('internal entities are read only when asked for, at most once a minute, shared', async () => {
  const device = makeDevice();
  device._polledAt = 0;
  const reads = [];
  let fail = false;
  device.client = {
    getEntities: async list => {
      reads.push(list.length);
      if (fail) throw new Error('HTTP 404 on /openquatt/entities');
      return [
        {
          id: 'sensor-hp1_-_compressor_starts_2h', name: 'HP1 - Compressor starts 2h', value: 4, state: '4',
        },
        {
          id: 'number-compressor_starts_2h_warning_limit', name: 'Compressor starts 2h warning limit', value: '6', state: '6',
        },
      ];
    },
  };

  // Not asked for: no read.
  await device.refreshPolledEntities(['sensor-total_power_input']);
  await device.refreshPolledEntities(false);
  assert.equal(reads.length, 0);

  // Two viewers at once share one read.
  await Promise.all([
    device.refreshPolledEntities(['sensor-hp1_-_compressor_starts_2h']),
    device.refreshPolledEntities(true),
  ]);
  assert.equal(reads.length, 1);
  assert.deepEqual(
    device.getRemoteSnapshot({ entities: ['sensor-hp1_-_compressor_starts_2h', 'number-compressor_starts_2h_warning_limit'] })
      .entities.map(entity => entity.value),
    [4, 6],
  );

  // Fresh enough: no new read.
  await device.refreshPolledEntities(true);
  assert.equal(reads.length, 1);

  // A failed read keeps the last values and does not throw.
  device._polledAt = 0;
  fail = true;
  await device.refreshPolledEntities(true);
  assert.equal(reads.length, 2);
  assert.equal(device.getRemoteSnapshot({ entities: ['sensor-hp1_-_compressor_starts_2h'] }).entities[0].value, 4);
});

const HP1_UNIT_CAPABILITIES = [
  'oq_compressor_frequency.hp1',
  'oq_compressor_starts_2h.hp1',
  'oq_compressor_starts_24h.hp1',
  'oq_runtime_hours.hp1',
];

test('each unit\'s compressor frequency, running hours and starts feed their capabilities', async () => {
  const device = makeDevice({ capabilities: [...ALL_CAPABILITIES, ...HP1_UNIT_CAPABILITIES] });
  device._polledAt = 0;
  device.client = {
    getEntities: async () => [
      {
        id: 'sensor-hp1_-_compressor_starts_2h', name: 'HP1 - Compressor starts 2h', value: 4, state: '4',
      },
      {
        id: 'sensor-hp1_-_compressor_starts_24h', name: 'HP1 - Compressor starts 24h', value: 8, state: '8',
      },
      {
        id: 'sensor-hp1_-_compressor_starts_6h', name: 'HP1 - Compressor starts 6h', value: 7, state: '7',
      },
    ],
  };

  device._onState({ id: 'sensor-hp1_-_compressor_frequency', value: 48, state: '48 Hz' });
  device._onState({ id: 'sensor-hp1_-_runtime_hours', value: 8.7, state: '8.7 h' });
  await device.refreshPolledEntities(true);

  assert.equal(device.capabilityValues['oq_compressor_frequency.hp1'], 48);
  assert.equal(device.capabilityValues['oq_runtime_hours.hp1'], 8.7);
  assert.equal(device.capabilityValues['oq_compressor_starts_2h.hp1'], 4);
  assert.equal(device.capabilityValues['oq_compressor_starts_24h.hp1'], 8);
  // The other windows stay on the remote page only.
  assert.deepEqual(Object.keys(device.capabilityValues).filter(cap => cap.includes('starts')).sort(), [
    'oq_compressor_starts_24h.hp1', 'oq_compressor_starts_2h.hp1',
  ]);
});

test('HP2 capabilities come with the first HP2 frame, filled with what is known', async () => {
  const device = makeDevice({ capabilities: [...ALL_CAPABILITIES, ...HP1_UNIT_CAPABILITIES] });
  const capabilities = device.getCapabilities();

  // Not a unit reading the widget keeps, so no sign of HP2 yet.
  device._onState({ id: 'sensor-hp2_-_runtime_hours', value: 9.1, state: '9.1 h' });
  assert.ok(!capabilities.includes('oq_runtime_hours.hp2'));

  device._onState({ id: 'sensor-hp2_-_compressor_frequency', value: 39, state: '39 Hz' });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(capabilities.filter(cap => cap.endsWith('.hp2')), [
    'oq_compressor_frequency.hp2',
    'oq_compressor_starts_2h.hp2',
    'oq_compressor_starts_24h.hp2',
    'oq_runtime_hours.hp2',
  ]);
  assert.equal(device.capabilityValues['oq_compressor_frequency.hp2'], 39);
  assert.equal(device.capabilityValues['oq_runtime_hours.hp2'], 9.1);

  // From then on HP2 frames feed them directly.
  device._onState({ id: 'sensor-hp2_-_compressor_frequency', value: 52, state: '52 Hz' });
  assert.equal(device.capabilityValues['oq_compressor_frequency.hp2'], 52);
});
