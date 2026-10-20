'use strict';

const Homey = require('homey');
const OpenQuattClient = require('../../lib/OpenQuattClient');
const { MqttPublisher } = require('../../lib/MqttPublisher');
const { DewPointSources } = require('../../lib/dewPoint');
const { API_INPUTS, formatInput } = require('../../lib/apiInputs');
const { ID_TO_OPTION, OPTION_TO_ID } = require('../../lib/auxFunctions');
const { remoteLogin, MIN_PASSWORD_LENGTH } = require('../../lib/RemoteAccess');
const { History } = require('../../lib/History');
const { parseEnergyHistory } = require('../../lib/energyHistory');

// Entity id (as seen on the /events stream) -> Homey capability. Every
// capability here is also an Insights log, which is the point of exposing the
// numbers and booleans below rather than keeping them widget-only telemetry.
// The firmware has no system-wide return sensor; the return water enters at
// HP1, whose water inlet the web app's overview shows as the return as well.
// The effective supply target is what the heating curve control steers to: an
// external target while one is valid, the curve with its corrections otherwise.
const ENTITY_CAPABILITIES = {
  'sensor-water_supply_temp__selected_': 'measure_temperature.supply',
  'sensor-hp1_-_water_in_temperature': 'measure_temperature.return',
  'sensor-heating_supply_target__effective_': 'measure_temperature.supply_target',
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
  'measure_temperature.return',
  'measure_temperature.supply_target',
];

// Devices paired before v1.12.0 were thermostats, a class for which Homey does
// not let the user pick the status indicator on the device tile.
const DEVICE_CLASS = 'heatpump';

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

// Numeric capabilities that fire a changed trigger and two threshold triggers.
// Values are compared at the precision the device shows, so sensor noise below
// it does not fire anything; the threshold cards decide in the driver whether
// a change crossed their own threshold.
const NUMERIC_TRIGGERS = {
  oq_flow: {
    token: 'flow', decimals: 0, cards: ['flow_changed', 'flow_rose_above', 'flow_dropped_below'],
  },
};

// Telemetry keys that feed the aggregated fault state.
const FAULT_KEYS = ['hp1Failures', 'hp2Failures', 'lowflowFault', 'flowMismatch', 'otLinkProblem'];

// The SSE stream replays every entity right after connect; wait for that burst
// to finish before treating fault changes as real transitions.
const FAULT_SETTLE_MS = 15000;

// Extra entities kept in memory for the widgets — not exposed as capabilities
// to avoid cluttering the device page.
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
  'select-quatt_hybrid_version': 'hybridVersion',
};

// Per-unit entities for the heat pump widget. Both units carry the same set
// under their own prefix ("HP1 - ", "HP2 - "), so they are keyed by domain and
// the object id after that prefix. HP2 only exists on duo installations.
const HEATPUMP_ENTITIES = {
  'text_sensor-working_mode_label': 'mode',
  'binary_sensor-defrost': 'defrost',
  'text_sensor-active_failures_list': 'failures',
  'sensor-compressor_frequency': 'frequency',
  'sensor-fan_speed': 'fanSpeed',
  'sensor-outside_temperature': 'outside',
  'sensor-power_input': 'power',
  'sensor-heat_power': 'heatPower',
  'sensor-cooling_power': 'coolPower',
  'sensor-cop': 'cop',
  'sensor-eer': 'eer',
  'sensor-water_in_temperature': 'waterIn',
  'sensor-water_out_temperature': 'waterOut',
  'sensor-flow': 'flow',
};

const HEATPUMP_ENTITY_ID = /^([a-z_]+)-(hp[12])_-_(.+)$/;

// The aux relay function select is `internal: true` in the firmware, so it is
// absent from the event stream and has to be polled via REST.
const AUX_FUNCTION_POLL_MS = 60000;

// Feeding external source values. The firmware expires them after 10 to 30
// minutes depending on the signal, so a minute-cadence republish keeps every
// fed value alive. What is fed, and over which routes, lives in lib/apiInputs.js.
const INPUT_PUBLISH_MS = 60000;

// The remote page, served from the repository's docs folder; the Homey id in
// the fragment tells it which Homey to call, without sending it to the host.
const REMOTE_PAGE_URL = 'https://openquatt.github.io/homey-openquatt/remote/';

// The remote page's 24-hour charts: sampled every minute, averaged per five
// minutes, and saved now and then so an app restart does not wipe them.
const HISTORY_FIELDS = [
  ['supply', 1], ['return', 1], ['target', 1], ['outside', 1], ['room', 1], ['setpoint', 1],
  ['power', 0], ['heat', 0], ['cool', 0], ['flow', 0], ['hp1', 0], ['hp2', 0],
];
const HISTORY_SAMPLE_MS = 60 * 1000;
const HISTORY_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_SPAN_MS = 24 * 60 * 60 * 1000;
const HISTORY_SAVE_MS = 30 * 60 * 1000;
const HISTORY_STORE_KEY = 'history';

// Entities the firmware keeps off the event stream (`internal: true`), read
// through its bulk endpoint while the remote page asks for them, at most once
// a minute: the compressor start counters and their warning limits.
const POLLED_ENTITIES = [
  ...['HP1', 'HP2'].flatMap(unit => [
    ...['2h', '6h', '24h', '72h'].map(window => ['sensor', `${unit} - Compressor starts ${window}`]),
    ['sensor', `${unit} - Compressor last start age`],
  ]),
  ['number', 'Compressor starts 2h warning limit'],
  ['number', 'Compressor starts 72h warning limit'],
  ['binary_sensor', 'Compressor cycling alert latched'],
];
const POLLED_ENTITY_IDS = new Set(POLLED_ENTITIES.map(([domain, name]) => (
  `${domain}-${name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`)));
const POLLED_MAX_AGE_MS = 60 * 1000;

// The energy history comes from the controller on request; a short cache keeps
// a remote viewer paging back and forth from loading the ESP.
const ENERGY_CACHE_MS = 2 * 60 * 1000;
const ENERGY_CACHE_SIZE = 12;

// Persisted commands (setpoint, heating permission) are re-asserted on start,
// so a controller that restarted meanwhile gets the standing value back.
const INPUT_STORE_KEY = 'inputs';

/**
 * The value behind a state frame, typed by the entity domain rather than by
 * what it feeds: `sensor-` is numeric (the firmware sends "NA" when it has
 * nothing to report), `number-` too (sent as a string), binary sensors and
 * switches are booleans, and the remaining text entities carry their state as
 * a string.
 */
function entityValue(state) {
  if (state.id.startsWith('sensor-')) {
    return typeof state.value === 'number' && Number.isFinite(state.value) ? state.value : null;
  }
  if (state.id.startsWith('number-')) {
    const value = state.value === '' || state.value === null ? NaN : Number(state.value);
    return Number.isFinite(value) ? value : null;
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
    this._heatpumps = {};
    this._binary = {};
    this._numeric = {};
    this._entities = {};
    this._polledAt = 0;
    this._energyCache = new Map();
    this._faultActive = null;
    this._deliveryProblems = {};

    await this._migrateClass();
    await this._migrateCapabilities();
    this._showRemoteLink().catch(this.error);

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

    this.client = new OpenQuattClient(this._address(), this._credentials(this.getSettings()));
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
      const reason = err && err.statusCode === 401 ? 'device.login_rejected' : 'device.unreachable';
      this.setUnavailable(this.homey.__(reason)).catch(this.error);
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

    this._history = new History({
      fields: HISTORY_FIELDS, intervalMs: HISTORY_INTERVAL_MS, spanMs: HISTORY_SPAN_MS,
    });
    this._history.restore(this.getStoreValue(HISTORY_STORE_KEY), Date.now());
    this._historyTimer = this.homey.setInterval(() => this._recordHistory(), HISTORY_SAMPLE_MS);
    this._historySaveTimer = this.homey.setInterval(() => this._saveHistory(), HISTORY_SAVE_MS);
  }

  async onUninit() {
    this._teardown();
  }

  async onDeleted() {
    this._teardown({ saveHistory: false });
  }

  async onSettings({ newSettings, changedKeys }) {
    // Refusing the save keeps remote access from opening with a missing or
    // weak login.
    if (newSettings.remote_enabled && !remoteLogin(newSettings)) {
      throw new Error(this.homey.__('remote.login_required', { length: MIN_PASSWORD_LENGTH }));
    }
    if (newSettings.address) this.client.setHost(newSettings.address);
    this.client.setCredentials(this._credentials(newSettings));
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

  /**
   * Stop feeding a command that has no neutral value to send instead. The
   * controller keeps the last value until its own validity window runs out,
   * then falls back to its own source.
   */
  releaseInput(key) {
    if (!this._inputs[key]) return;
    delete this._inputs[key];
    delete this._deliveryProblems[key];
    if (API_INPUTS[key].persist) this._storeInputs();
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

  _teardown({ saveHistory = true } = {}) {
    if (this._historyTimer) {
      this.homey.clearInterval(this._historyTimer);
      this.homey.clearInterval(this._historySaveTimer);
      this._historyTimer = null;
      if (saveHistory) this._saveHistory();
    }
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

  // Devices keep the class they were paired with; move older ones over.
  async _migrateClass() {
    if (this.getClass() !== DEVICE_CLASS) await this.setClass(DEVICE_CLASS).catch(this.error);
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

  _credentials(settings) {
    return { username: settings.web_username || '', password: settings.web_password || '' };
  }

  // A label setting, so the link can be copied from the device settings.
  async _showRemoteLink() {
    const link = `${REMOTE_PAGE_URL}#${await this.homey.cloud.getHomeyId()}`;
    if (this.getSetting('remote_link') !== link) await this.setSettings({ remote_link: link });
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

  /**
   * The live values of one heat pump unit ('hp1' or 'hp2') for the heat pump
   * widget, or null while the controller has not reported that unit, which on
   * a single installation is always the case for HP2.
   */
  getHeatpump(unit) {
    const values = this._heatpumps[unit];
    if (!values) return null;
    const heatpump = { ...values };
    // A Quatt Hybrid V1 has no usable flow reading on HP1 itself; the web app
    // shows the system's selected flow there instead, and so does the widget.
    if (unit === 'hp1' && this._telemetry.hybridVersion === 'V1') {
      heatpump.flow = this.hasCapability('oq_flow') ? this.getCapabilityValue('oq_flow') : null;
    }
    return heatpump;
  }

  /**
   * Everything the remote page shows: the capabilities and widget data, and
   * on request the entities the controller reports, as the firmware formats
   * them: all of them (`true`), or the ids asked for.
   */
  getRemoteSnapshot({ entities = false } = {}) {
    const capabilities = {};
    for (const id of this.getCapabilities()) capabilities[id] = this.getCapabilityValue(id);
    const snapshot = {
      name: this.getName(),
      available: this.getAvailable(),
      capabilities,
      telemetry: this.getTelemetry(),
      heatpumps: { hp1: this.getHeatpump('hp1'), hp2: this.getHeatpump('hp2') },
    };
    if (entities === true) {
      snapshot.entities = Object.entries(this._entities).map(([id, entity]) => ({ id, ...entity }));
    } else if (Array.isArray(entities)) {
      snapshot.entities = entities
        .filter(id => Object.prototype.hasOwnProperty.call(this._entities, id))
        .map(id => ({ id, ...this._entities[id] }));
    }
    return snapshot;
  }

  /**
   * Bring the entities kept off the event stream up to date when the remote
   * page asks for any of them (or for everything) and they are older than a
   * minute. Concurrent viewers share one read; a failed read leaves the last
   * values, as firmware without these entities simply never has them.
   */
  async refreshPolledEntities(entities) {
    const wanted = entities === true || (Array.isArray(entities) && entities.some(id => POLLED_ENTITY_IDS.has(id)));
    if (!wanted || Date.now() - this._polledAt < POLLED_MAX_AGE_MS) return;
    if (!this._polling) {
      this._polling = this.client.getEntities(POLLED_ENTITIES)
        .then(states => {
          for (const state of states) this._storeEntity(state);
          this._polledAt = Date.now();
        })
        .catch(err => this.log(`internal entities unavailable: ${err.message}`))
        .finally(() => { this._polling = null; });
    }
    await this._polling;
  }

  getRemoteHistory() {
    return this._history.toJSON(Date.now());
  }

  /**
   * The controller's energy history for a range checked by the caller (see
   * lib/energyHistory), parsed into day and hour records.
   */
  async getEnergyHistory({ from, to, hours }) {
    const key = `${from}-${to}-${hours ? 1 : 0}`;
    const cached = this._energyCache.get(key);
    if (cached && Date.now() - cached.at < ENERGY_CACHE_MS) return cached.data;

    const text = await this.client.getText(`/energy/history?from=${from}&to=${to}&hours=${hours ? 1 : 0}`);
    const data = parseEnergyHistory(text);
    this._energyCache.delete(key);
    this._energyCache.set(key, { at: Date.now(), data });
    if (this._energyCache.size > ENERGY_CACHE_SIZE) {
      this._energyCache.delete(this._energyCache.keys().next().value);
    }
    return data;
  }

  // Only while the controller is connected: otherwise the values are stale,
  // and a gap in the chart is the honest picture.
  _recordHistory() {
    if (!this.getAvailable()) return;
    const cap = id => (this.hasCapability(id) ? this.getCapabilityValue(id) : null);
    const frequency = unit => (this._heatpumps[unit] ? this._heatpumps[unit].frequency : null);
    this._history.record(Date.now(), {
      supply: cap('measure_temperature.supply'),
      return: cap('measure_temperature.return'),
      target: cap('measure_temperature.supply_target'),
      outside: cap('measure_temperature.outside'),
      room: cap('measure_temperature.room'),
      setpoint: cap('measure_temperature.setpoint'),
      power: cap('measure_power'),
      heat: cap('oq_heat_power'),
      cool: cap('oq_cool_power'),
      flow: cap('oq_flow'),
      hp1: frequency('hp1'),
      hp2: frequency('hp2'),
    });
  }

  _saveHistory() {
    this.setStoreValue(HISTORY_STORE_KEY, this._history.toJSON(Date.now())).catch(this.error);
  }

  // Every entity, for the remote page. Web server v2 frames carry no display
  // name; the page then falls back to the id.
  _storeEntity(state) {
    this._entities[state.id] = {
      name: state.name || null,
      state: typeof state.state === 'string' ? state.state : null,
      value: entityValue(state),
    };
  }

  _onState(state) {
    this._storeEntity(state);

    const telemetryKey = TELEMETRY_ENTITIES[state.id];
    if (telemetryKey) {
      this._telemetry[telemetryKey] = entityValue(state);
      if (FAULT_KEYS.includes(telemetryKey)) this._evaluateFaults();
      // No early return: an entity may feed both the widget and a capability.
    }

    const unit = HEATPUMP_ENTITY_ID.exec(state.id);
    const heatpumpKey = unit && HEATPUMP_ENTITIES[`${unit[1]}-${unit[3]}`];
    if (heatpumpKey) {
      if (!this._heatpumps[unit[2]]) this._heatpumps[unit[2]] = {};
      this._heatpumps[unit[2]][heatpumpKey] = entityValue(state);
      // No early return here either: the HP1 water inlet is also the return
      // temperature capability, and the defrost entities fire triggers.
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

    const value = entityValue(state);
    this.setCapabilityValue(capability, value).catch(this.error);

    const numericTrigger = NUMERIC_TRIGGERS[capability];
    if (numericTrigger) this._onNumericTrigger(capability, numericTrigger, value);
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

  // Like the binary triggers, the first value only records state. A reading
  // without a value ("NA") is skipped, so a sensor dropout is not a drop to 0.
  _onNumericTrigger(capability, card, raw) {
    if (raw === null) return;
    const factor = 10 ** card.decimals;
    const value = Math.round(raw * factor) / factor;
    const previous = this._numeric[capability];
    this._numeric[capability] = value;
    if (previous === undefined || previous === value) return;
    for (const id of card.cards) {
      this.homey.flow.getDeviceTriggerCard(id)
        .trigger(this, { [card.token]: value }, { previous, current: value })
        .catch(this.error);
    }
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
