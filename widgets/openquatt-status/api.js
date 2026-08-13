'use strict';

module.exports = {

  async getStatus({ homey }) {
    const driver = homey.drivers.getDriver('openquatt');
    const devices = driver.getDevices();
    if (!devices.length) return { paired: false };

    // Single-controller households are the norm; take the first device.
    const device = devices[0];
    const cap = id => (device.hasCapability(id) ? device.getCapabilityValue(id) : null);
    const telemetry = device.getTelemetry();

    const problems = [];
    if (telemetry.hp1Failures && telemetry.hp1Failures !== 'None') {
      problems.push(`HP1: ${telemetry.hp1Failures}`);
    }
    if (telemetry.hp2Failures && telemetry.hp2Failures !== 'None') {
      problems.push(`HP2: ${telemetry.hp2Failures}`);
    }
    if (telemetry.lowflowFault) problems.push('Lage doorstroming — beveiliging actief');
    if (telemetry.flowMismatch) problems.push('Flow-verschil tussen HP1 en HP2');
    if (telemetry.otLinkProblem) problems.push('OpenTherm-verbinding verstoord');

    return {
      paired: true,
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
