'use strict';

const UNITS = ['hp1', 'hp2'];

module.exports = {

  async getHeatpump({ homey, query }) {
    const driver = homey.drivers.getDriver('openquatt');
    const devices = driver.getDevices();
    if (!devices.length) return { paired: false, language: homey.i18n.getLanguage() };

    // Single-controller households are the norm; take the first device.
    const device = devices[0];
    const unit = UNITS.includes(query.unit) ? query.unit : 'hp1';

    return {
      paired: true,
      language: homey.i18n.getLanguage(),
      available: device.getAvailable(),
      unit,
      heatpump: device.getHeatpump(unit),
    };
  },

};
