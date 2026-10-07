'use strict';

const Homey = require('homey');
const OpenQuattClient = require('../../lib/OpenQuattClient');
const { MqttPublisher } = require('../../lib/MqttPublisher');
const { DewPointSources } = require('../../lib/dewPoint');
const { API_INPUTS, formatInput } = require('../../lib/apiInputs');
const { ID_TO_OPTION, OPTION_TO_ID } = require('../../lib/auxFunctions');

// Entity id (as seen on the /events stream) -> Homey capability. Every
// capability here is also an Insights log, which is the point of exposing the
// numbers and booleans below rather than keeping them widget-only telemetry.
const ENTITY_CAPABILITIES = {
  'sensor-water_supply_temp__selected_': 'measure_temperature.supply',
  'sensor-outside_temperature__selected_': 'measure_temperature.outside',
  'sensor-room_temperature__selected_': 'measure_temperature.room',
  'sensor-room_setpoint__selected_': 'measure_temperature.setpoint',
  'sensor-cooling_dew_point__selected_': 'measure_temperature.dew_point',
  'sensor-total_power_input': 'measure_power',
  'sensor-total_heat_power': 'oq_heat_power',
  'sensor-total_cooling_power': 'oq_cool_power',
  'sensor-total_cop': 'oq_cop',
  'sensor-total_eer': 'oq_eer',
  'sensor-flow_average__selected_': 'oq_flow',
  'binary_sensor-heating_enable__selected_': 'oq_heating_permitted',
  'binary_sensor-cooling_enable__selected_': 'oq_cooling_permitted',
  'switch-openquatt_enabled': 'onoff.openquatt',
  'switch-manual_cooling_enable': 'onoff.cooling',
  'switch-aux_relay__r2_': 'onoff.aux_relay',
  'text_sensor-control_mode__label_': 'oq_control_mode',
  'text_sensor-aux_relay_status': 'oq_aux_status',
};

// Capabilities added after the first release; devices paired earlier get them
// on the next app start.
const MIGRATED_CAPABILITIES = [
  'oq_aux_function',
  'oq_aux_status',
  'measure_temperature.dew_point',
  'measure_temperature.setpoint',
  'oq_heat_power',
  'oq_cool_power',
  'oq_cop',
  'oq_eer',
  'oq_flow',
  'oq_control_mode_number',
  'oq_heating_permitted',
  'oq_cooling_permitted',
  'onoff.openquatt',
];

const HEATING_MODES = ['CM2', 'CM3', 'CM4'];

// Binary entities that fire started/stopped flow triggers on state edges.
// HP2 entities only exist on duo installations; absent ids simply never fire.
const BINARY_TRIGGERS = {
  'binary_sensor-hp1_-_defrost': { on: 'defrost_started', off: 'defrost_stopped', tokens: { heatpump: 'HP1' } },
  'binary_sensor-hp2_-_defrost': { on: 'defrost_started', off: 'defrost_stopped', tokens: { heatpump: 'HP2' } },
  'binary_sensor-boiler_active': { on: 'boiler_started', off: 'boiler_stopped' },
  'binary_sensor-silent_active': { on: 'silent_started', off: 'silent_stopped' },
  'binary_sensor-cooling_dew_point_available': { on: 'dew_point_available', off: 'dew_point_lost' },
};

// Telemetry keys that feed the aggregated fault state.
const FAULT_KEYS = ['hp1Failures', 'hp2Failures', 'lowflowFault', 'flowMismatch', 'otLinkProblem'];

// The SSE stream replays every entity right after connect; wait for that burst
// to finish before treating fault changes as real transitions.
const FAULT_SETTLE_MS = 15000;

// Extra entities kept in memory for the status widget — not exposed as
// capabilities to avoid cluttering the device page.
const TELEMETRY_ENTITIES = {
  'text_sensor-hp1_-_active_failures_list': 'hp1Failures',
  'text_sensor-hp2_-_active_failures_list': 'hp2Failures',
  'binary_sensor-lowflow_fault_active': 'lowflowFault',
  'binary_sensor-flow_mismatch__hp1_vs_hp2_': 'flowMismatch',
  'binary_sensor-ot_-_link_problem': 'otLinkProblem',
  'text_sensor-cooling_block_reason': 'coolingBlockReason',
  'sensor-total_heat_power': 'heatPower',
  'sensor-total_cooling_power': 'coolPower',
  'sensor-heatpump_thermal_energy_daily': 'thermalDaily',
  'sensor-heatpump_cooling_energy_daily': 'coolingDaily',
  'sensor-electrical_energy_daily': 'electricDaily',
  'sensor-heatpump_cop_daily': 'copDaily',
  'sensor-heatpump_eer_daily': 'eerDaily',
  'binary_sensor-cooling_permitted': 'coolingPermitted',
  'sensor-cooling_effective_minimum_supply_temp': 'minSupplyTemp',
};

// The aux relay function select is `internal: true` in the firmware, so it is
// absent from the event stream and has to be polled via REST.
const AUX_FUNCTION_POLL_MS = 60000;

// Feeding external source values. The firmware expires them after 10 to 30
// minutes depending on the signal, so a minute-cadence republish keeps every
// fed value alive. What is fed, and over which routes, lives in lib/apiInputs.js.
const INPUT_PUBLISH_MS = 60000;

// Persisted commands (setpoint, heating permission) are re-asserted on start,
// so a controller that restarted meanwhile gets the standing value back.
const INPUT_STORE_KEY = 'inputs';

/**
 * The value behind a state frame, typed by the entity domain rather than by
 * what it feeds: `sensor-` is numeric (the firmware sends "NA" when it has
 * nothing to report), binary sensors and switches are booleans, and the
 * remaining text entities carry their state as a string.
 */
function entityValue(state) {
  if (state.id.startsWith('sensor-')) {
    return typeof state.value === 'number' && Number.isFinite(state.value) ? state.value : null;
  }
  if (state.id.startsWith('binary_sensor-') || state.id.startsWith('switch-')) {
    return state.value === true || state.state === 'ON';
  }
  return typeof state.state === 'string' ? state.state : null;
}

class OpenQuattDevice extends Homey.Device {

  async onInit() {
    this._controlModeCode = null;
    this._telemetry = {};
    this._binary = {};
    this._faultActive = null;
    this._deliveryProblems = {};

    await this._migrateCapabilities();

    this.registerCapabilityListener('onoff.openquatt', async value => {
      await this.client.setSwitch('OpenQuatt Enabled', value);
    });
    this.registerCapabilityListener('onoff.cooling', async value => {
      await this.client.setSwitch('Manual Cooling Enable', value);
    });
    this.registerCapabilityListener('onoff.aux_relay', async value => {
      await this.client.setSwitch('Aux relay (R2)', value);
    });
    this.registerCapabilityListener('oq_aux_function', async value => {
      await this.client.setSelect('Aux Relay Function', ID_TO_OPTION[value]);
    });

    this.client = new OpenQuattClient(this._address());
    this.client.on('connected', () => {
      this.setAvailable().catch(this.error);
      // Establish the fault baseline once, after the initial state burst, so a
      // fault that already exists at app start does not fire a trigger.
      if (this._faultActive === null && !this._faultSettleTimer) {
        this._faultSettleTimer = this.homey.setTimeout(() => {
          this._faultSettleTimer = null;
          if (this._faultActive === null) this._faultActive = this.getFaults().length > 0;
        }, FAULT_SETTLE_MS);
      }
      // Eager refresh with short retries so the picker populates right after
      // (re)connect instead of waiting for the next poll tick.
      this._refreshAuxFunction();
      this.homey.setTimeout(() => this._refreshAuxFunction(), 2000);
      this.homey.setTimeout(() => this._refreshAuxFunction(), 10000);
    });
    this.client.on('disconnected', err => {
      this.setUnavailable(this.homey.__('device.unreachable')).catch(this.error);
      if (err) this.log(`disconnected: ${err.message}`);
    });
    this.client.on('state', state => this._onState(state));
    this.client.connect();

    this._auxPollTimer = this.homey.setInterval(
      () => this._refreshAuxFunction(),
      AUX_FUNCTION_POLL_MS,
    );

    this._dewPointSources = new DewPointSources();
    this._inputs = this._restoreInputs();
    this._setupInputPublisher(this.getSettings());
    this._inputTimer = this.homey.setInterval(
      () => this._publishInputs().catch(this.error),
      INPUT_PUBLISH_MS,
    );
  }

  async onUninit() {
    this._teardown();
  }

  async onDeleted() {
    this._teardown();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (newSettings.address) this.client.setHost(newSettings.address);
    if (changedKeys.some(key => key.startsWith('mqtt_'))) {
      this._setupInputPublisher(newSettings);
    }
  }

  onDiscoveryResult(discoveryResult) {
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult) {
    this._updateAddress(discoveryResult.address);
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this._updateAddress(discoveryResult.address);
  }

  isCooling() {
    return this._controlModeCode === 'CM5';
  }

  isHeating() {
    return HEATING_MODES.includes(this._controlModeCode);
  }

  isDefrosting() {
    return this._binary['binary_sensor-hp1_-_defrost'] === true
      || this._binary['binary_sensor-hp2_-_defrost'] === true;
  }

  isBoilerActive() {
    return this._binary['binary_sensor-boiler_active'] === true;
  }

  isSilentActive() {
    return this._binary['binary_sensor-silent_active'] === true;
  }

  isDewPointAvailable() {
    return this._binary['binary_sensor-cooling_dew_point_available'] === true;
  }

  isCoolingPermitted() {
    return this._telemetry.coolingPermitted === true;
  }

  /**
   * Record a dew point value from a flow card and push the aggregate (the
   * highest fresh source) to the controller.
   */
  async setDewPoint(source, value) {
    if (formatInput('dew_point', value) === null) throw new Error(this._rangeError('dew_point'));
    this._dewPointSources.update(source, value, Date.now());
    const aggregate = this._dewPointSources.aggregate(Date.now(), this._maxAgeMs());
    if (aggregate !== null && await this._deliver('dew_point', aggregate) === false) {
      throw new Error(this.homey.__('input.delivery_failed'));
    }
  }

  /**
   * Record any other external source value from a flow card and push it to the
   * controller straight away. Commands stand until a new value arrives (most
   * are also remembered across restarts); measurements expire with the
   * configured sensor age.
   */
  async setInput(key, value) {
    if (formatInput(key, value) === null) throw new Error(this._rangeError(key));
    const previous = this._inputs[key];
    this._inputs[key] = { value, updatedAt: Date.now() };
    // Only persisted commands are stored, and only when they actually change: a
    // flow may repeat the same setpoint all day.
    if (API_INPUTS[key].persist && (!previous || previous.value !== value)) this._storeInputs();
    if (await this._deliver(key, value) === false) {
      throw new Error(this.homey.__('input.delivery_failed'));
    }
  }

  hasFault() {
    return this.getFaults().length > 0;
  }

  getFaults() {
    const t = this._telemetry;
    const faults = [];
    if (t.hp1Failures && t.hp1Failures !== 'None') faults.push(`HP1: ${t.hp1Failures}`);
    if (t.hp2Failures && t.hp2Failures !== 'None') faults.push(`HP2: ${t.hp2Failures}`);
    if (t.lowflowFault) faults.push(this.homey.__('fault.lowflow'));
    if (t.flowMismatch) faults.push(this.homey.__('fault.flow_mismatch'));
    if (t.otLinkProblem) faults.push(this.homey.__('fault.ot_link'));
    return faults;
  }

  _teardown() {
    if (this._auxPollTimer) {
      this.homey.clearInterval(this._auxPollTimer);
      this._auxPollTimer = null;
    }
    if (this._inputTimer) {
      this.homey.clearInterval(this._inputTimer);
      this._inputTimer = null;
    }
    if (this._faultSettleTimer) {
      this.homey.clearTimeout(this._faultSettleTimer);
      this._faultSettleTimer = null;
    }
    if (this._publisher) {
      this._publisher.close();
      this._publisher = null;
    }
    if (this.client) this.client.close();
  }

  // Devices paired with an older app version keep their original capability
  // list; add capabilities introduced since.
  async _migrateCapabilities() {
    for (const capability of MIGRATED_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch(this.error);
      }
    }
  }

  _setupInputPublisher(settings) {
    if (this._publisher) {
      this._publisher.close();
      this._publisher = null;
    }
    const host = (settings.mqtt_host || '').trim();
    if (!host) return;

    this._publisher = new MqttPublisher({
      host,
      port: Number(settings.mqtt_port) || 1883,
      username: settings.mqtt_username || '',
      password: settings.mqtt_password || '',
      clientId: `homey-openquatt-${String(this.getData().id).replace(/[^a-zA-Z0-9_-]/g, '')}`.slice(0, 40),
    });
    this._topicPrefix = `openquatt/${(settings.mqtt_device_name || '').trim() || 'openquatt'}/`;
    this._publisher.on('connected', () => this.log('mqtt: connected'));
    this._publisher.on('disconnected', err => this.log(`mqtt: disconnected (${err.message})`));
    this._publisher.connect();
  }

  // Re-assert everything the app currently feeds, so no source runs into the
  // firmware's validity window while Homey still has a value for it.
  async _publishInputs() {
    const now = Date.now();
    const pending = [];

    const dewPoint = this._dewPointSources.aggregate(now, this._maxAgeMs());
    if (dewPoint !== null) pending.push(['dew_point', dewPoint]);

    for (const [key, entry] of Object.entries(this._inputs)) {
      // A measurement nobody refreshed is no longer worth asserting: dropping
      // it lets the controller fall back to its own source. Commands stand.
      if (!API_INPUTS[key].command && now - entry.updatedAt > this._maxAgeMs()) {
        delete this._inputs[key];
        delete this._deliveryProblems[key];
        continue;
      }
      pending.push([key, entry.value]);
    }

    // Sequentially: the ESP is heap-constrained, so keep the connection count
    // to one at a time.
    for (const [key, value] of pending) {
      await this._deliver(key, value);
    }
  }

  /**
   * Deliver one source value to the controller: the API input first (zero
   * configuration, needs firmware with API input support), then MQTT as
   * fallback for older firmware. Both carry the same value; the firmware
   * ignores whichever route it is not configured to use.
   */
  async _deliver(key, value) {
    const input = API_INPUTS[key];
    const payload = formatInput(key, value);
    if (payload === null) return false;

    let delivered = false;
    try {
      if (input.boolean) await this.client.setSwitch(input.entity, value);
      else await this.client.setNumber(input.entity, payload);
      delivered = true;
    } catch (err) {
      // Typically: firmware without the API input (404), or device offline.
      this._logDeliveryState(key, `api input unavailable: ${err.message}`);
    }
    if (this._publisher) {
      delivered = this._publisher.publish(this._topicPrefix + input.topic, payload) || delivered;
    }
    if (delivered) this._logDeliveryState(key, null);
    return delivered;
  }

  // The republish loop runs every minute; only log state *changes*, per input.
  _logDeliveryState(key, problem) {
    if (this._deliveryProblems[key] === problem) return;
    this._deliveryProblems[key] = problem;
    this.log(problem ? `${key}: ${problem}` : `${key}: delivery ok`);
  }

  _maxAgeMs() {
    return (Number(this.getSetting('dew_point_max_age')) || 60) * 60 * 1000;
  }

  _rangeError(key) {
    const input = API_INPUTS[key];
    const range = input.boolean ? '' : ` (${input.min}…${input.max} °C)`;
    return `${this.homey.__('input.out_of_range')}${range}`;
  }

  // Commands survive an app restart, so a controller that restarted meanwhile
  // gets the standing value back on the next publish tick.
  _restoreInputs() {
    const stored = this.getStoreValue(INPUT_STORE_KEY) || {};
    const now = Date.now();
    const inputs = {};
    for (const [key, value] of Object.entries(stored)) {
      if (formatInput(key, value) !== null) inputs[key] = { value, updatedAt: now };
    }
    return inputs;
  }

  _storeInputs() {
    const stored = {};
    for (const [key, entry] of Object.entries(this._inputs)) {
      if (API_INPUTS[key].persist) stored[key] = entry.value;
    }
    this.setStoreValue(INPUT_STORE_KEY, stored).catch(this.error);
  }

  async _refreshAuxFunction() {
    if (!this.hasCapability('oq_aux_function')) return;
    try {
      const entity = await this.client.getEntity('select', 'Aux Relay Function');
      const id = OPTION_TO_ID[entity.state];
      if (id && this.getCapabilityValue('oq_aux_function') !== id) {
        await this.setCapabilityValue('oq_aux_function', id);
      }
    } catch (err) {
      // Typically: device offline, or firmware without the R2 feature (the
      // select then 404s). Leave the picker empty rather than guessing.
      this.log(`aux relay function unavailable: ${err.message}`);
    }
  }

  _address() {
    const override = this.getSetting('address');
    if (override) return override;
    return this.getStore().address;
  }

  _updateAddress(address) {
    if (!address || this.getSetting('address')) return;
    this.setStoreValue('address', address).catch(this.error);
    this.client.setHost(address);
  }

  getTelemetry() {
    return { ...this._telemetry, controlModeCode: this._controlModeCode };
  }

  _onState(state) {
    const telemetryKey = TELEMETRY_ENTITIES[state.id];
    if (telemetryKey) {
      this._telemetry[telemetryKey] = entityValue(state);
      if (FAULT_KEYS.includes(telemetryKey)) this._evaluateFaults();
      // No early return: an entity may feed both the widget and a capability.
    }

    // The raw control mode code drives the flow triggers.
    if (state.id === 'text_sensor-control_mode') {
      this._onControlMode(state.state);
      return;
    }

    const binaryTrigger = BINARY_TRIGGERS[state.id];
    if (binaryTrigger) {
      this._onBinaryTrigger(state.id, binaryTrigger, state.value === true || state.state === 'ON');
      return;
    }

    const capability = ENTITY_CAPABILITIES[state.id];
    if (!capability || !this.hasCapability(capability)) return;

    this.setCapabilityValue(capability, entityValue(state)).catch(this.error);
  }

  _onControlMode(code) {
    if (typeof code !== 'string' || code === this._controlModeCode) return;
    const previous = this._controlModeCode;
    this._controlModeCode = code;
    this._setControlModeNumber(code);

    // Skip triggers on the very first value after (re)connect.
    if (previous === null) return;

    const tokens = { mode: code };
    this.homey.flow.getDeviceTriggerCard('control_mode_changed')
      .trigger(this, tokens)
      .catch(this.error);

    if (code === 'CM5') {
      this.homey.flow.getDeviceTriggerCard('cooling_started')
        .trigger(this)
        .catch(this.error);
    } else if (previous === 'CM5') {
      this.homey.flow.getDeviceTriggerCard('cooling_stopped')
        .trigger(this)
        .catch(this.error);
    }

    // Heating spans multiple modes, so only fire on entering/leaving the set.
    const wasHeating = HEATING_MODES.includes(previous);
    const nowHeating = HEATING_MODES.includes(code);
    if (nowHeating && !wasHeating) {
      this.homey.flow.getDeviceTriggerCard('heating_started')
        .trigger(this)
        .catch(this.error);
    } else if (wasHeating && !nowHeating) {
      this.homey.flow.getDeviceTriggerCard('heating_stopped')
        .trigger(this)
        .catch(this.error);
    }
  }

  // Insights graphs numbers, not labels, so the mode is logged as its bare CM
  // code next to the readable oq_control_mode text.
  _setControlModeNumber(code) {
    if (!this.hasCapability('oq_control_mode_number')) return;
    const match = /^CM(\d+)$/i.exec(code);
    this.setCapabilityValue('oq_control_mode_number', match ? Number(match[1]) : null)
      .catch(this.error);
  }

  // The first value per entity only records state, so the replay burst after
  // (re)connect never fires a trigger for an unchanged value.
  _onBinaryTrigger(id, card, value) {
    const previous = this._binary[id];
    this._binary[id] = value;
    if (previous === undefined || previous === value) return;
    this.homey.flow.getDeviceTriggerCard(value ? card.on : card.off)
      .trigger(this, card.tokens || {})
      .catch(this.error);
  }

  _evaluateFaults() {
    if (this._faultActive === null) return;
    const faults = this.getFaults();
    const active = faults.length > 0;
    if (active === this._faultActive) return;
    this._faultActive = active;
    if (active) {
      this.homey.flow.getDeviceTriggerCard('fault_detected')
        .trigger(this, { fault: faults.join('; ') })
        .catch(this.error);
    } else {
      this.homey.flow.getDeviceTriggerCard('fault_resolved')
        .trigger(this)
        .catch(this.error);
    }
  }

}

module.exports = OpenQuattDevice;
