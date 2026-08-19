'use strict';

const Homey = require('homey');
const { ID_TO_OPTION } = require('../../lib/auxFunctions');
const { dewPoint } = require('../../lib/dewPoint');

// Flow dropdown id -> option string as the firmware select expects it.
const SILENT_OVERRIDE_OPTIONS = { schedule: 'Schedule', on: 'On', off: 'Off' };
const CM_OVERRIDE_OPTIONS = {
  auto: 'Auto', cm0: 'Force CM0', cm1: 'Force CM1', cm98: 'Force CM98',
};

class OpenQuattDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getConditionCard('is_cooling')
      .registerRunListener(async ({ device }) => device.isCooling());

    this.homey.flow.getConditionCard('is_heating')
      .registerRunListener(async ({ device }) => device.isHeating());

    this.homey.flow.getConditionCard('has_fault')
      .registerRunListener(async ({ device }) => device.hasFault());

    this.homey.flow.getConditionCard('is_defrosting')
      .registerRunListener(async ({ device }) => device.isDefrosting());

    this.homey.flow.getConditionCard('boiler_is_active')
      .registerRunListener(async ({ device }) => device.isBoilerActive());

    this.homey.flow.getConditionCard('silent_is_active')
      .registerRunListener(async ({ device }) => device.isSilentActive());

    this.homey.flow.getConditionCard('aux_function_is')
      .registerRunListener(async ({ device, mode }) => (
        device.getCapabilityValue('oq_aux_function') === mode
      ));

    this.homey.flow.getConditionCard('dew_point_is_available')
      .registerRunListener(async ({ device }) => device.isDewPointAvailable());

    this.homey.flow.getConditionCard('cooling_is_permitted')
      .registerRunListener(async ({ device }) => device.isCoolingPermitted());

    this.homey.flow.getActionCard('set_manual_cooling')
      .registerRunListener(async ({ device, state }) => {
        await device.client.setSwitch('Manual Cooling Enable', state === 'on');
      });

    this.homey.flow.getActionCard('set_aux_function')
      .registerRunListener(async ({ device, mode }) => {
        await device.client.setSelect('Aux Relay Function', ID_TO_OPTION[mode]);
        await device.setCapabilityValue('oq_aux_function', mode).catch(() => {});
      });

    this.homey.flow.getActionCard('set_aux_relay')
      .registerRunListener(async ({ device, state }) => {
        await device.client.setSwitch('Aux relay (R2)', state === 'on');
      });

    this.homey.flow.getActionCard('set_silent_override')
      .registerRunListener(async ({ device, mode }) => {
        await device.client.setSelect('Silent Mode Override', SILENT_OVERRIDE_OPTIONS[mode]);
      });

    this.homey.flow.getActionCard('force_control_mode')
      .registerRunListener(async ({ device, mode }) => {
        await device.client.setSelect('CM Override', CM_OVERRIDE_OPTIONS[mode]);
      });

    this.homey.flow.getActionCard('set_boiler_assist')
      .registerRunListener(async ({ device, state }) => {
        await device.client.setSwitch('Boiler assist enabled', state === 'on');
      });

    this.homey.flow.getActionCard('set_openquatt_enabled')
      .registerRunListener(async ({ device, state }) => {
        await device.client.setSwitch('OpenQuatt Enabled', state === 'on');
      });

    this.homey.flow.getActionCard('send_dew_point')
      .registerRunListener(async ({ device, dewpoint }) => {
        await device.setDewPoint('flow', dewpoint);
      });

    this.homey.flow.getActionCard('send_room_dew_point')
      .registerRunListener(async ({
        device, room, temperature, humidity,
      }) => {
        const value = dewPoint(temperature, humidity);
        if (value === null) throw new Error(this.homey.__('dew_point.invalid_input'));
        await device.setDewPoint(`room:${room.trim().toLowerCase()}`, value);
        return { dewpoint: Math.round(value * 100) / 100 };
      });
  }

  async onPairListDevices() {
    const strategy = this.getDiscoveryStrategy();
    const results = Object.values(strategy.getDiscoveryResults());

    return results.map(result => ({
      name: result.name || 'OpenQuatt',
      data: { id: result.id },
      store: { address: result.address },
    }));
  }

}

module.exports = OpenQuattDriver;
