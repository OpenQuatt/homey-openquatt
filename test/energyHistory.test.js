'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseEnergyHistory, energyHistoryRange } = require('../lib/energyHistory');

// Shaped after a real v0.55 response: metadata, day records stored more than
// once while a day runs, hour records, and the running day.
const RESPONSE = [
  '@schema|3',
  '@enabled|1',
  '@csrf|secret',
  '@range|20261017|20261019|1',
  '@bounds|2|20261017|20261018|2|20261017|20261018',
  '0|20261017|1|3508|2798|336|13138|939|0|13138',
  '1|20261017|1|3797|3048|336|14207|939|0|14208',
  '3|20261018|0|8168|7534|0|32623|0|0|32584',
  '2|20261017|0|3991|3191|336|14830|939|0|14841',
  '@hours|39|7',
  '@hour|40|20261019|8|827|793|0|3412|0|0|3420',
  '@hour|39|20261019|7|357|338|0|1424|0|0|1420',
  '@hour|41|20261019|8|830|796|0|3420|0|0|3425',
  '@current|20261019|2642|2418|0|10211|0|0|10221',
  'garbage',
  '9|20260230|0|1|1|1|1|1|1|1',
].join('\r\n');

test('the latest record per day wins, and the running day replaces its record', () => {
  const { days } = parseEnergyHistory(RESPONSE);
  assert.deepEqual(days, [
    {
      date: 20261017, electrical: 3991, heatingInput: 3191, coolingInput: 336, heat: 14830, cooling: 939, boiler: 0, system: 14841,
    },
    {
      date: 20261018, electrical: 8168, heatingInput: 7534, coolingInput: 0, heat: 32623, cooling: 0, boiler: 0, system: 32584,
    },
    {
      date: 20261019, electrical: 2642, heatingInput: 2418, coolingInput: 0, heat: 10211, cooling: 0, boiler: 0, system: 10221, current: true,
    },
  ]);
});

test('hours come in order, the latest record per hour winning', () => {
  const { hours } = parseEnergyHistory(RESPONSE);
  assert.deepEqual(hours.map(hour => [hour.date, hour.hour, hour.electrical, hour.heat]), [
    [20261019, 7, 357, 1424],
    [20261019, 8, 830, 3420],
  ]);
});

test('missing or negative values become null; empty input parses to nothing', () => {
  const { days } = parseEnergyHistory('0|20261017|0|12||-5|abc|0|0|0');
  assert.deepEqual(days[0], {
    date: 20261017, electrical: 12, heatingInput: null, coolingInput: null, heat: null, cooling: 0, boiler: 0, system: 0,
  });
  assert.deepEqual(parseEnergyHistory(undefined), { days: [], hours: [], bounds: null });
});

test('ranges are checked: real dates, in order, and not too long', () => {
  assert.deepEqual(energyHistoryRange(20261001, 20261019, false), { from: 20261001, to: 20261019, hours: false });
  assert.deepEqual(energyHistoryRange(20261013, 20261019, true), { from: 20261013, to: 20261019, hours: true });
  assert.equal(energyHistoryRange(20261012, 20261019, true), null);
  assert.equal(energyHistoryRange(20251001, 20261105, false), null);
  assert.equal(energyHistoryRange(20261019, 20261001, false), null);
  assert.equal(energyHistoryRange(20260230, 20261001, false), null);
  assert.equal(energyHistoryRange('20261001', 20261019, false), null);
  assert.equal(energyHistoryRange(undefined, undefined, undefined), null);
});

test('the stored bounds come along', () => {
  assert.deepEqual(parseEnergyHistory(RESPONSE).bounds, {
    oldest: 20261017, newest: 20261018, hoursOldest: 20261017, hoursNewest: 20261018,
  });
  assert.deepEqual(parseEnergyHistory('@bounds|0|0|0|0|0|0').bounds, {
    oldest: null, newest: null, hoursOldest: null, hoursNewest: null,
  });
});
