'use strict';

// Homey enum id <-> OpenQuatt select option ("Room Temperature Source"). The
// room setpoint has a select of its own and keeps its source.
const ROOM_SOURCE_TO_OPTION = {
  ot_thermostat: 'OT thermostat',
  cic: 'CIC',
  ha_input: 'HA input',
  api_input: 'API input',
  mqtt: 'MQTT',
};

const OPTION_TO_ROOM_SOURCE = Object.fromEntries(
  Object.entries(ROOM_SOURCE_TO_OPTION).map(([id, option]) => [option, id]),
);

module.exports = { ROOM_SOURCE_TO_OPTION, OPTION_TO_ROOM_SOURCE };
