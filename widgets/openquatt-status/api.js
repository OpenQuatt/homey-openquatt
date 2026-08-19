'use strict';

module.exports = {

  async getStatus({ homey }) {
    const driver = homey.drivers.getDriver('openquatt');
    const devices = driver.getDevices();
    if (!devices.length) return { paired: false, language: homey.i18n.getLanguage() };

    // Single-controller households are the norm; take the first device.
    const device = devices[0];
    const cap = id => (device.hasCapability(id) ? device.getCapabilityValue(id) : null);
    const telemetry = device.getTelemetry();

    // Same aggregation (and translations) as the fault flow cards.
    const problems = device.getFaults();

    return {
      paired: true,
      language: homey.i18n.getLanguage(),
      available: device.getAvailable(),
      name: device.getName(),
      controlMode: cap('oq_control_mode'),
      supply: cap('measure_temperature.supply'),
      outside: cap('measure_temperature.outside'),
      room: cap('measure_temperature.room'),
      power: cap('measure_power'),
      problems,
      telemetry,
    };
  },

};
