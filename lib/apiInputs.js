'use strict';

/**
 * The external source values the controller accepts, with both routes to it:
 * the API input entity on the ESPHome web server, and the fixed MQTT input
 * topic (suffixed onto `openquatt/<device_name>/`) as fallback for firmware
 * without API input support. Ranges follow the OpenQuatt docs
 * (docs/api-input.md, docs/mqtt.md); values outside them are ignored by the
 * firmware and make that source invalid, so they never leave the app.
 *
 * `persist: true` marks a command rather than a measurement: the controller
 * keeps it until a new value arrives, so the app neither expires it after the
 * configured sensor age nor forgets it across a restart.
 */
const API_INPUTS = {
  dew_point: {
    entity: 'api_input_cooling_dew_point',
    topic: 'input/cooling/dew_point',
    min: -20,
    max: 35,
  },
  outside_temperature: {
    entity: 'api_input_outside_temperature',
    topic: 'input/weather/outdoor_temperature',
    min: -40,
    max: 60,
  },
  room_temperature: {
    entity: 'api_input_room_temperature',
    topic: 'input/thermostat/room_temperature',
    min: 0,
    max: 50,
  },
  room_setpoint: {
    entity: 'api_input_room_setpoint',
    topic: 'input/thermostat/room_setpoint',
    min: 5,
    max: 35,
    persist: true,
  },
  heating_enable: {
    entity: 'api_input_heating_enable',
    topic: 'input/thermostat/heating_enable',
    boolean: true,
    persist: true,
  },
};

/**
 * The wire payload for an input value — the same string on both routes — or
 * null when the value is of the wrong type or outside the accepted range.
 */
function formatInput(key, value) {
  const input = API_INPUTS[key];
  if (!input) return null;
  if (input.boolean) return typeof value === 'boolean' ? String(value) : null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < input.min || value > input.max) return null;
  return value.toFixed(2);
}

module.exports = { API_INPUTS, formatInput };
