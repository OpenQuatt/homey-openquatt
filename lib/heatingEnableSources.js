'use strict';

// Homey enum id <-> OpenQuatt select option ("Heating Enable Source").
// `disabled` is not "heating off": it drops the permission gate, so the
// heating strategy decides by itself when heat is needed.
const SOURCE_TO_OPTION = {
  disabled: 'Disabled',
  ot_thermostat: 'OT thermostat',
  cic: 'CIC',
  ha_input: 'HA input',
  api_input: 'API input',
  mqtt: 'MQTT',
};

const OPTION_TO_SOURCE = Object.fromEntries(
  Object.entries(SOURCE_TO_OPTION).map(([id, option]) => [option, id]),
);

module.exports = { SOURCE_TO_OPTION, OPTION_TO_SOURCE };
