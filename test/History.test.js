'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { History } = require('../lib/History');

const MINUTE = 60 * 1000;
const FIELDS = [['supply', 1], ['power', 0]];

function makeHistory(spanMs = 60 * MINUTE) {
  return new History({ fields: FIELDS, intervalMs: 5 * MINUTE, spanMs });
}

test('values are averaged per interval, missing ones left out', () => {
  const history = makeHistory();
  history.record(0, { supply: 40, power: 500 });
  history.record(MINUTE, { supply: 41, power: null });
  history.record(2 * MINUTE, { supply: 42.04, power: 'NA' });
  history.record(5 * MINUTE, { supply: 50, power: 700.6 });

  assert.deepEqual(history.toJSON(6 * MINUTE), {
    interval: 5 * MINUTE,
    fields: ['supply', 'power'],
    rows: [
      [0, 41, 500],
      // The interval in progress is included.
      [5 * MINUTE, 50, 701],
    ],
  });
});

test('an interval without any value for a field keeps a gap', () => {
  const history = makeHistory();
  history.record(0, { supply: null, power: 300 });
  assert.deepEqual(history.toJSON(MINUTE).rows, [[0, null, 300]]);
});

test('rows older than the span drop out', () => {
  const history = makeHistory(15 * MINUTE);
  for (let t = 0; t <= 30 * MINUTE; t += 5 * MINUTE) history.record(t, { supply: t / MINUTE, power: 1 });

  assert.deepEqual(history.toJSON(30 * MINUTE).rows.map(row => row[0] / MINUTE), [20, 25, 30]);
  // Also when nothing was recorded since.
  assert.deepEqual(history.toJSON(40 * MINUTE).rows.map(row => row[0] / MINUTE), [30]);
});

test('saved rows come back, unless they no longer fit', () => {
  const history = makeHistory();
  history.record(0, { supply: 40, power: 500 });
  history.record(5 * MINUTE, { supply: 41, power: 510 });
  const saved = JSON.parse(JSON.stringify(history.toJSON(6 * MINUTE)));

  // The interval still in progress at save time is recorded afresh.
  const restored = makeHistory();
  restored.restore(saved, 7 * MINUTE);
  assert.deepEqual(restored.toJSON(7 * MINUTE).rows, [[0, 40, 500]]);

  // Too old by now.
  const late = makeHistory();
  late.restore(saved, 66 * MINUTE);
  assert.deepEqual(late.toJSON(66 * MINUTE).rows, []);

  // Recorded with other fields or another interval.
  const other = new History({ fields: [['supply', 1]], intervalMs: 5 * MINUTE, spanMs: 60 * MINUTE });
  other.restore(saved, 7 * MINUTE);
  assert.deepEqual(other.toJSON(7 * MINUTE).rows, []);
  const coarse = new History({ fields: FIELDS, intervalMs: 10 * MINUTE, spanMs: 60 * MINUTE });
  coarse.restore(saved, 7 * MINUTE);
  assert.deepEqual(coarse.toJSON(7 * MINUTE).rows, []);

  assert.doesNotThrow(() => makeHistory().restore(undefined, 0));
  assert.doesNotThrow(() => makeHistory().restore({ interval: 5 * MINUTE, fields: ['supply', 'power'], rows: [[1], 'x'] }, 0));
});
