'use strict';

const http = require('http');
const { EventEmitter } = require('events');

const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
// ESPHome sends a ping event roughly every 30s; treat a silent hour-glass as dead.
const IDLE_TIMEOUT_MS = 90000;

/**
 * Client for the OpenQuatt (ESPHome) web server.
 *
 * State updates arrive as Server-Sent Events on GET /events. Every entity is
 * pushed on connect, then again on every change. Commands go through the REST
 * routes, which are addressed by URL-encoded DISPLAY NAME (not object_id) and
 * require an explicit Content-Length header on POST (the server answers 411
 * otherwise). These routes also reach `internal: true` entities such as the
 * aux relay configuration selects.
 */
class OpenQuattClient extends EventEmitter {

  constructor(host) {
    super();
    this.host = host;
    this._req = null;
    this._closed = false;
    this._backoff = RECONNECT_MIN_MS;
    this._idleTimer = null;
    this._reconnectTimer = null;
  }

  connect() {
    this._closed = false;
    this._open();
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._stopIdleTimer();
    if (this._req) {
      this._req.destroy();
      this._req = null;
    }
  }

  setHost(host) {
    if (host === this.host) return;
    this.host = host;
    if (!this._closed) {
      // Reconnect against the new address.
      if (this._req) this._req.destroy();
    }
  }

  // The address may carry an explicit port ("host:8080"); ESPHome defaults to 80.
  _endpoint() {
    const match = /^(.+):(\d+)$/.exec(this.host);
    if (match) return { host: match[1], port: Number(match[2]) };
    return { host: this.host, port: 80 };
  }

  async setSwitch(name, on) {
    const action = on ? 'turn_on' : 'turn_off';
    await this._post(`/switch/${encodeURIComponent(name)}/${action}`);
  }

  async setSelect(name, option) {
    await this._post(`/select/${encodeURIComponent(name)}/set?option=${encodeURIComponent(option)}`);
  }

  async setNumber(name, value) {
    await this._post(`/number/${encodeURIComponent(name)}/set?value=${encodeURIComponent(value)}`);
  }

  async pressButton(name) {
    await this._post(`/button/${encodeURIComponent(name)}/press`);
  }

  /**
   * Read a single entity via REST. Works for `internal: true` entities that
   * never appear on the /events stream, such as the aux relay function select.
   */
  getEntity(domain, name) {
    return new Promise((resolve, reject) => {
      const req = http.get({
        ...this._endpoint(),
        path: `/${domain}/${encodeURIComponent(name)}`,
        timeout: 5000,
      }, res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} on /${domain}/${name}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`timeout on /${domain}/${name}`)));
      req.on('error', reject);
    });
  }

  _open() {
    if (this._closed) return;

    const req = http.get({
      ...this._endpoint(),
      path: '/events',
      headers: { Accept: 'text/event-stream' },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        this._scheduleReconnect(new Error(`HTTP ${res.statusCode} on /events`));
        return;
      }

      this._backoff = RECONNECT_MIN_MS;
      this.emit('connected');

      let buffer = '';
      let eventType = null;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        this._resetIdleTimer();
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            if (eventType === 'state') {
              try {
                const state = JSON.parse(line.slice(5).trim());
                if (state && state.id) this.emit('state', state);
              } catch (err) { /* ignore malformed frames */ }
            }
          } else if (line === '') {
            eventType = null;
          }
        }
      });
      res.on('end', () => this._scheduleReconnect(new Error('stream ended')));
      res.on('error', err => this._scheduleReconnect(err));
    });

    req.on('error', err => this._scheduleReconnect(err));
    this._req = req;
    this._resetIdleTimer();
  }

  _scheduleReconnect(err) {
    if (this._closed) return;
    this._stopIdleTimer();
    if (this._req) {
      this._req.destroy();
      this._req = null;
    }
    this.emit('disconnected', err);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._open(), this._backoff);
    this._backoff = Math.min(this._backoff * 2, RECONNECT_MAX_MS);
  }

  _resetIdleTimer() {
    this._stopIdleTimer();
    this._idleTimer = setTimeout(() => {
      this._scheduleReconnect(new Error('idle timeout'));
    }, IDLE_TIMEOUT_MS);
  }

  _stopIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _post(path) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        ...this._endpoint(),
        path,
        method: 'POST',
        // Without this the ESPHome web server rejects the POST with HTTP 411.
        headers: { 'Content-Length': '0' },
        timeout: 5000,
      }, res => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`HTTP ${res.statusCode} on ${path}`));
      });
      req.on('timeout', () => req.destroy(new Error(`timeout on ${path}`)));
      req.on('error', reject);
      req.end();
    });
  }

}

module.exports = OpenQuattClient;
