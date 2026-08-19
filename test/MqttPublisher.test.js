'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const {
  MqttPublisher, encodeString, encodeLength, encodeConnect, encodePublish,
} = require('../lib/MqttPublisher');

test('encodeString prefixes the UTF-8 byte length', () => {
  assert.deepEqual(encodeString('ab'), Buffer.from([0x00, 0x02, 0x61, 0x62]));
  assert.deepEqual(encodeString(''), Buffer.from([0x00, 0x00]));
});

test('encodeLength uses the MQTT variable-length scheme', () => {
  assert.deepEqual(encodeLength(0), Buffer.from([0x00]));
  assert.deepEqual(encodeLength(127), Buffer.from([0x7f]));
  assert.deepEqual(encodeLength(128), Buffer.from([0x80, 0x01]));
  assert.deepEqual(encodeLength(321), Buffer.from([0xc1, 0x02]));
});

test('encodeConnect builds a valid MQTT 3.1.1 CONNECT packet', () => {
  const packet = encodeConnect({ clientId: 'homey', username: 'user', password: 'pw' });
  assert.equal(packet[0], 0x10);
  // Protocol name "MQTT", level 4.
  assert.deepEqual(packet.subarray(2, 8), Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54]));
  assert.equal(packet[8], 0x04);
  // Clean session + username + password flags.
  assert.equal(packet[9], 0x02 | 0x80 | 0x40);
  assert.ok(packet.includes(Buffer.from('homey')));
  assert.ok(packet.includes(Buffer.from('user')));
  assert.ok(packet.includes(Buffer.from('pw')));
});

test('a password without username is not encoded', () => {
  const packet = encodeConnect({ clientId: 'homey', username: '', password: 'pw' });
  assert.equal(packet[9], 0x02);
  assert.ok(!packet.includes(Buffer.from('pw')));
});

test('encodePublish is QoS 0 without retain', () => {
  const packet = encodePublish('openquatt/openquatt/input/cooling/dew_point', '15.60');
  assert.equal(packet[0], 0x30);
  assert.ok(packet.includes(Buffer.from('input/cooling/dew_point')));
  assert.ok(packet.subarray(-5).equals(Buffer.from('15.60')));
});

// Minimal in-process broker: accepts any CONNECT, then hands PUBLISH
// payloads to the test.
function startBroker(onPublish, connackCode = 0) {
  return new Promise(resolve => {
    const server = net.createServer(socket => {
      socket.on('data', chunk => {
        const type = chunk[0] & 0xF0;
        if (type === 0x10) {
          socket.write(Buffer.from([0x20, 0x02, 0x00, connackCode]));
        } else if (type === 0x30) {
          // Fixed header, then 2-byte topic length + topic, then the payload.
          let offset = 1;
          while (chunk[offset] & 0x80) offset += 1;
          offset += 1;
          const topicLength = chunk.readUInt16BE(offset);
          const topic = chunk.subarray(offset + 2, offset + 2 + topicLength).toString();
          const payload = chunk.subarray(offset + 2 + topicLength).toString();
          onPublish({ topic, payload });
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('publishes to the broker after a successful connect', async () => {
  const published = [];
  const server = await startBroker(message => published.push(message));
  const publisher = new MqttPublisher({
    host: '127.0.0.1',
    port: server.address().port,
    clientId: 'homey-openquatt-test',
  });

  try {
    await new Promise((resolve, reject) => {
      publisher.on('connected', resolve);
      publisher.on('disconnected', reject);
      publisher.connect();
    });

    assert.equal(publisher.publish('openquatt/openquatt/input/cooling/dew_point', '14.20'), true);
    await new Promise(resolve => { setTimeout(resolve, 50); });
    assert.deepEqual(published, [
      { topic: 'openquatt/openquatt/input/cooling/dew_point', payload: '14.20' },
    ]);
  } finally {
    publisher.close();
    server.close();
  }
});

test('publish reports false while not connected', () => {
  const publisher = new MqttPublisher({ host: '127.0.0.1', port: 1, clientId: 'x' });
  assert.equal(publisher.publish('topic', '1.00'), false);
});

test('a refused connect surfaces as a disconnect with the broker reason', async () => {
  const server = await startBroker(() => {}, 5);
  const publisher = new MqttPublisher({
    host: '127.0.0.1',
    port: server.address().port,
    clientId: 'homey-openquatt-test',
  });

  try {
    const err = await new Promise(resolve => {
      publisher.on('disconnected', resolve);
      publisher.connect();
    });
    assert.match(err.message, /not authorized/);
    assert.equal(publisher.ready, false);
  } finally {
    publisher.close();
    server.close();
  }
});
