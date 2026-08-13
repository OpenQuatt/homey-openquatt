'use strict';

const Homey = require('homey');
const OpenQuattClient = require('../../lib/OpenQuattClient');
const { ID_TO_OPTION, OPTION_TO_ID } = require('../../lib/auxFunctions');

// Entity id (as seen on the /events stream) -> Homey capability.
const ENTITY_CAPABILITIES = {
  'sensor-water_supply_temp__selected_': 'measure_temperature.supply',
  'sensor-outside_temperature__selected_': 'measure_temperature.outside',
  'sensor-room_temperature__selected_': 'measure_temperature.room',
  'sensor-total_power_input': 'measure_power',
  'switch-manual_cooling_enable': 'onoff.cooling',
  'switch-aux_relay__r2_': 'onoff.aux_relay',
  'text_sensor-control_mode__label_': 'oq_control_mode',
  'text_sensor-aux_relay_status': 'oq_aux_status',
};

const HEATING_MODES = ['CM2', 'CM3', 'CM4'];

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
};

// The aux relay function select is `internal: true` in the firmware, so it is
// absent from the event stream and has to be polled via REST.
const AUX_FUNCTION_POLL_MS = 60000;

class OpenQuattDevice extends Homey.Device {

  async onInit() {
    this._controlModeCode = null;
    this._telemetry = {};

    await this._migrateCapabilities();

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
  }

  async onUninit() {
    this._teardown();
  }

  async onDeleted() {
    this._teardown();
  }

  async onSettings({ newSettings }) {
    if (newSettings.address) this.client.setHost(newSettings.address);
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

  _teardown() {
    if (this._auxPollTimer) {
      this.homey.clearInterval(this._auxPollTimer);
      this._auxPollTimer = null;
    }
    if (this.client) this.client.close();
  }

  // Devices paired with an older app version keep their original capability
  // list; add capabilities introduced since.
  async _migrateCapabilities() {
    for (const capability of ['oq_aux_function', 'oq_aux_status']) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch(this.error);
      }
    }
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
      if (state.id.startsWith('binary_sensor-')) {
        this._telemetry[telemetryKey] = state.value === true || state.state === 'ON';
      } else if (state.id.startsWith('sensor-')) {
        this._telemetry[telemetryKey] = typeof state.value === 'number' && Number.isFinite(state.value)
          ? state.value
          : null;
      } else {
        this._telemetry[telemetryKey] = typeof state.state === 'string' ? state.state : null;
      }
      return;
    }

    // The raw control mode code drives the flow triggers.
    if (state.id === 'text_sensor-control_mode') {
      this._onControlMode(state.state);
      return;
    }

    const capability = ENTITY_CAPABILITIES[state.id];
    if (!capability || !this.hasCapability(capability)) return;

    let value;
    if (capability.startsWith('onoff')) {
      value = state.value === true || state.state === 'ON';
    } else if (capability.startsWith('oq_')) {
      value = typeof state.state === 'string' ? state.state : null;
    } else {
      value = typeof state.value === 'number' && Number.isFinite(state.value)
        ? state.value
        : null;
    }

    this.setCapabilityValue(capability, value).catch(this.error);
  }

  _onControlMode(code) {
    if (typeof code !== 'string' || code === this._controlModeCode) return;
    const previous = this._controlModeCode;
    this._controlModeCode = code;

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
  }

}

module.exports = OpenQuattDevice;
