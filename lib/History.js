'use strict';

/**
 * A rolling history at a fixed interval, for the remote page's charts. Values
 * are recorded as often as the caller likes and averaged per interval, so a
 * point stands for the whole interval rather than the moment it was sampled.
 * A value that is missing (null) is left out of the average; an interval
 * without any value for a field keeps null there, which a chart shows as a gap.
 */
class History {

  /**
   * @param {Array<[string, number]>} fields name and decimals per field
   */
  constructor({ fields, intervalMs, spanMs }) {
    this.fields = fields;
    this.intervalMs = intervalMs;
    this.spanMs = spanMs;
    this._rows = [];
    this._bucket = null;
  }

  record(now, sample) {
    const start = Math.floor(now / this.intervalMs) * this.intervalMs;
    if (this._bucket && this._bucket.start !== start) this._close();
    if (!this._bucket) {
      this._bucket = { start, sums: this.fields.map(() => 0), counts: this.fields.map(() => 0) };
    }
    this.fields.forEach(([name], index) => {
      const value = sample[name];
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      this._bucket.sums[index] += value;
      this._bucket.counts[index]++;
    });
  }

  /**
   * Rows of [interval start, ...averages] within the span, oldest first, the
   * interval in progress included so a chart reaches the present.
   */
  toJSON(now) {
    const rows = this._bucket ? [...this._rows, this._average(this._bucket)] : this._rows;
    return {
      interval: this.intervalMs,
      fields: this.fields.map(([name]) => name),
      rows: rows.filter(row => now - row[0] < this.spanMs),
    };
  }

  /**
   * Take back rows saved earlier with toJSON, as long as they were recorded
   * with the same interval and fields; anything else is ignored.
   */
  restore(saved, now) {
    if (!saved || saved.interval !== this.intervalMs || !Array.isArray(saved.rows)) return;
    const names = this.fields.map(([name]) => name);
    if (!Array.isArray(saved.fields) || saved.fields.join() !== names.join()) return;
    this._rows = saved.rows.filter(row => Array.isArray(row)
      && row.length === names.length + 1
      && Number.isFinite(row[0])
      && now - row[0] < this.spanMs
      && row[0] < Math.floor(now / this.intervalMs) * this.intervalMs);
  }

  _close() {
    this._rows.push(this._average(this._bucket));
    this._bucket = null;
    const oldest = this._rows[this._rows.length - 1][0] - this.spanMs;
    while (this._rows.length && this._rows[0][0] <= oldest) this._rows.shift();
  }

  _average(bucket) {
    return [bucket.start, ...this.fields.map(([, decimals], index) => {
      if (!bucket.counts[index]) return null;
      const factor = 10 ** decimals;
      return Math.round((bucket.sums[index] / bucket.counts[index]) * factor) / factor;
    })];
  }

}

module.exports = { History };
