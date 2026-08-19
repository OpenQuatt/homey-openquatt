'use strict';

// Magnus constants, identical to the OpenQuatt Home Assistant cooling package
// so both integrations compute the same dew point from the same sensor data.
const MAGNUS_B = 17.62;
const MAGNUS_C = 243.12;

/**
 * Dew point in °C from air temperature (°C) and relative humidity (%),
 * or null when the inputs cannot produce a meaningful value.
 */
function dewPoint(temperature, humidity) {
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) return null;
  if (humidity <= 0 || humidity > 100) return null;
  const gamma = Math.log(humidity / 100) + (MAGNUS_B * temperature) / (MAGNUS_C + temperature);
  return (MAGNUS_C * gamma) / (MAGNUS_B - gamma);
}

/**
 * Named dew point sources (rooms, direct flow values) with a freshness window.
 * The aggregate is the HIGHEST fresh value: for cooling that is the safest
 * floor, matching the firmware's own Auto source selection.
 */
class DewPointSources {

  constructor() {
    this._sources = new Map();
  }

  update(name, value, now) {
    this._sources.set(name, { value, updatedAt: now });
  }

  aggregate(now, maxAgeMs) {
    let highest = null;
    for (const [name, entry] of this._sources) {
      if (now - entry.updatedAt > maxAgeMs) {
        this._sources.delete(name);
        continue;
      }
      if (highest === null || entry.value > highest) highest = entry.value;
    }
    return highest;
  }

}

module.exports = { dewPoint, DewPointSources };
