'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const CONNECT_TIMEOUT_MS = 10000;
const KEEPALIVE_S = 60;
const PING_INTERVAL_MS = 30000;

// MQTT 3.1.1 packet types (first nibble of the fixed header).
const PACKET_CONNECT = 0x10;
const PACKET_CONNACK = 0x20;
const PACKET_PUBLISH = 0x30;
const PACKET_PINGREQ = 0xC0;
const PACKET_DISCONNECT = 0xE0;

const CONNACK_ERRORS = {
  1: 'unacceptable protocol version',
  2: 'client identifier rejected',
  3: 'server unavailable',
  4: 'bad username or password',
  5: 'not authorized',
};

/** MQTT UTF-8 string: 2-byte big-endian length prefix plus the bytes. */
function encodeString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const buf = Buffer.alloc(2 + bytes.length);
  buf.writeUInt16BE(bytes.length, 0);
  bytes.copy(buf, 2);
  return buf;
}

/** MQTT variable-length "remaining length" field (7 bits per byte). */
function encodeLength(length) {
  const bytes = [];
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 0x80;
    bytes.push(digit);
  } while (length > 0);
  return Buffer.from(bytes);
}

function encodeConnect({ clientId, username, password }) {
  // Clean session; the password flag is only valid together with a username.
  let flags = 0x02;
  const payload = [encodeString(clientId)];
  if (username) {
    flags |= 0x80;
    payload.push(encodeString(username));
    if (password) {
      flags |= 0x40;
      payload.push(encodeString(password));
    }
  }
  const variable = Buffer.concat([
    encodeString('MQTT'),
    Buffer.from([0x04, flags, KEEPALIVE_S >> 8, KEEPALIVE_S & 0xff]),
  ]);
  const body = Buffer.concat([variable, ...payload]);
  return Buffer.concat([Buffer.from([PACKET_CONNECT]), encodeLength(body.length), body]);
}

function encodePublish(topic, message) {
  // QoS 0, no retain: a dew point must never outlive its measurement, so the
  // broker may not replay an old value to a (re)subscribing controller.
  const body = Buffer.concat([encodeString(topic), Buffer.from(message, 'utf8')]);
  return Buffer.concat([Buffer.from([PACKET_PUBLISH]), encodeLength(body.length), body]);
}

/**
 * Minimal MQTT 3.1.1 publish-only client (QoS 0), kept dependency-free.
 *
 * Deliberately does NOT queue while disconnected: a buffered dew point
 * delivered minutes later would look fresh to the controller's staleness
 * check while it no longer is. Callers simply publish again on their own
 * cadence once the connection is back.
 */
class MqttPublisher extends EventEmitter {

  constructor({
    host, port, username, password, clientId,
  }) {
    super();
    this.host = host;
    this.port = port || 1883;
    this.username = username || '';
    this.password = password || '';
    this.clientId = clientId || 'homey-openquatt';
    this._socket = null;
    this._ready = false;
    this._closed = false;
    this._backoff = RECONNECT_MIN_MS;
    this._pingTimer = null;
    this._reconnectTimer = null;
  }

  connect() {
    this._closed = false;
    this._open();
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._stopPing();
    if (this._socket) {
      if (this._ready) this._socket.write(Buffer.from([PACKET_DISCONNECT, 0x00]));
      this._socket.destroy();
      this._socket = null;
    }
    this._ready = false;
  }

  get ready() {
    return this._ready;
  }

  /** Publish immediately, or report false when there is no live connection. */
  publish(topic, message) {
    if (!this._ready || !this._socket) return false;
    this._socket.write(encodePublish(topic, message));
    return true;
  }

  _open() {
    if (this._closed) return;

    const socket = net.connect({ host: this.host, port: this.port });
    this._socket = socket;
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(encodeConnect(this));
    });

    socket.on('data', chunk => {
      // Ping responses count as liveness; the CONNACK decides ready state.
      if (this._ready) return;
      if (chunk.length < 4 || (chunk[0] & 0xF0) !== PACKET_CONNACK) return;
      const code = chunk[3];
      if (code !== 0) {
        socket.destroy(new Error(`MQTT connect refused: ${CONNACK_ERRORS[code] || `code ${code}`}`));
        return;
      }
      socket.setTimeout(0);
      this._ready = true;
      this._backoff = RECONNECT_MIN_MS;
      this._startPing();
      this.emit('connected');
    });

    socket.on('timeout', () => socket.destroy(new Error('connect timeout')));
    socket.on('error', err => { this._lastError = err; });
    socket.on('close', () => {
      // Ignore the close of a socket we already replaced or tore down.
      if (this._socket !== socket) return;
      const err = this._lastError || new Error('connection closed');
      this._lastError = null;
      this._scheduleReconnect(err);
    });
  }

  _scheduleReconnect(err) {
    this._stopPing();
    this._ready = false;
    if (this._socket) {
      const socket = this._socket;
      this._socket = null;
      socket.destroy();
    }
    if (this._closed) return;
    this.emit('disconnected', err);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._open(), this._backoff);
    this._backoff = Math.min(this._backoff * 2, RECONNECT_MAX_MS);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._socket) this._socket.write(Buffer.from([PACKET_PINGREQ, 0x00]));
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

}

module.exports = {
  MqttPublisher, encodeString, encodeLength, encodeConnect, encodePublish,
};
