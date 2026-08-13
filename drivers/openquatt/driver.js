'use strict';

const Homey = require('homey');
const { ID_TO_OPTION } = require('../../lib/auxFunctions');

class OpenQuattDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getConditionCard('is_cooling')
      .registerRunListener(async ({ device }) => device.isCooling());

    this.homey.flow.getConditionCard('is_heating')
      .registerRunListener(async ({ device }) => device.isHeating());

    this.homey.flow.getConditionCard('aux_function_is')
      .registerRunListener(async ({ device, mode }) => (
        device.getCapabilityValue('oq_aux_function') === mode
      ));

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
