'use strict';

// The value columns of every energy history record, in the firmware's order,
// in Wh: electrical input in total, for heating and for cooling, then the heat
// pump's heat and cooling output, the boiler's heat and the system's heat.
const VALUE_KEYS = ['electrical', 'heatingInput', 'coolingInput', 'heat', 'cooling', 'boiler', 'system'];

// Ranges the remote page may ask for: days for up to a year or so, hours for
// up to a week, which keeps the controller's response small.
const MAX_DAYS = 400;
const MAX_HOUR_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKeyTime(key) {
  if (!Number.isInteger(key) || key < 20200101 || key > 29991231) return null;
  const year = Math.floor(key / 10000);
  const month = Math.floor(key / 100) % 100;
  const day = key % 100;
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return time;
}

function values(parts, offset) {
  const record = {};
  VALUE_KEYS.forEach((key, index) => {
    const value = Number(parts[offset + index]);
    record[key] = parts[offset + index] !== '' && Number.isFinite(value) && value >= 0 ? value : null;
  });
  return record;
}

/**
 * The range the remote page asked for as `{ from, to, hours }`, or null when
 * it is not a valid one. Dates are YYYYMMDD keys, as the firmware uses them.
 */
function energyHistoryRange(from, to, hours) {
  const start = dateKeyTime(from);
  const end = dateKeyTime(to);
  if (start === null || end === null || start > end) return null;
  const days = (end - start) / DAY_MS + 1;
  if (days > (hours === true ? MAX_HOUR_DAYS : MAX_DAYS)) return null;
  return { from, to, hours: hours === true };
}

/**
 * Parse the controller's /energy/history response: lines of `|`-separated
 * fields, metadata lines starting with `@`. Day records come as
 * `sequence|date|flags|values…`, hour records as `@hour|sequence|date|hour|values…`
 * and the running day as `@current|date|values…`. A date (or hour) may be
 * stored more than once; the highest sequence is the latest. The running day
 * replaces any stored record of the same date. `@bounds` tells the oldest and
 * newest stored date, for days and for hours, so a viewer knows how far back
 * to page.
 */
function parseEnergyHistory(text) {
  const days = new Map();
  const hours = new Map();
  let current = null;
  let bounds = null;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|');

    if (parts[0] === '@bounds') {
      const date = index => (dateKeyTime(Number(parts[index])) !== null ? Number(parts[index]) : null);
      bounds = {
        oldest: date(2), newest: date(3), hoursOldest: date(5), hoursNewest: date(6),
      };
    } else if (parts[0] === '@current') {
      const date = Number(parts[1]);
      if (parts.length >= 2 + VALUE_KEYS.length && dateKeyTime(date) !== null) {
        current = { date, ...values(parts, 2) };
      }
    } else if (parts[0] === '@hour') {
      const sequence = Number(parts[1]);
      const date = Number(parts[2]);
      const hour = Number(parts[3]);
      if (parts.length >= 4 + VALUE_KEYS.length && Number.isFinite(sequence)
        && dateKeyTime(date) !== null && Number.isInteger(hour) && hour >= 0 && hour <= 23) {
        const key = date * 100 + hour;
        const known = hours.get(key);
        if (!known || known.sequence < sequence) {
          hours.set(key, {
            sequence, date, hour, ...values(parts, 4),
          });
        }
      }
    } else if (!line.startsWith('@')) {
      const sequence = Number(parts[0]);
      const date = Number(parts[1]);
      if (parts.length >= 3 + VALUE_KEYS.length && Number.isFinite(sequence) && dateKeyTime(date) !== null) {
        const known = days.get(date);
        if (!known || known.sequence < sequence) days.set(date, { sequence, date, ...values(parts, 3) });
      }
    }
  }

  if (current) days.set(current.date, { ...current, current: true });
  const strip = ({ sequence, ...record }) => record;
  return {
    days: [...days.values()].sort((a, b) => a.date - b.date).map(strip),
    hours: [...hours.values()].sort((a, b) => (a.date - b.date) || (a.hour - b.hour)).map(strip),
    bounds,
  };
}

module.exports = {
  parseEnergyHistory,
  energyHistoryRange,
  VALUE_KEYS,
};
