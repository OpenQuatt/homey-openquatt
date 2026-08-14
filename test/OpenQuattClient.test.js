'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

const OpenQuattClient = require('../lib/OpenQuattClient');

// Spins up a local HTTP server that mimics the ESPHome web server. The handler
// receives (req, res) and every request is recorded for assertions.
async function withServer(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`;
  try {
    await run(host, requests);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function sseHandler(onStream) {
  return (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Push the headers out now; the client's response callback (and thus the
      // 'connected' event) fires on headers, not on the first data chunk.
      res.flushHeaders();
      onStream(res);
    } else {
      res.writeHead(404);
      res.end();
    }
  };
}

test('_endpoint defaults to port 80 and honours an explicit port', () => {
  assert.deepEqual(new OpenQuattClient('openquatt.local')._endpoint(), {
    host: 'openquatt.local',
    port: 80,
  });
  assert.deepEqual(new OpenQuattClient('192.168.1.10:8080')._endpoint(), {
    host: '192.168.1.10',
    port: 8080,
  });
});

test('emits parsed state events and ignores pings and malformed frames', async () => {
  let stream;
  await withServer(sseHandler(res => { stream = res; }), async host => {
    const client = new OpenQuattClient(host);
    try {
      const states = [];
      client.on('state', state => states.push(state));

      client.connect();
      await once(client, 'connected');

      stream.write('event: ping\r\ndata: \r\n\r\n');
      stream.write('event: state\r\ndata: {"id":"sensor-total_power_input","value":123.4,"state":"123.4 W"}\r\n\r\n');
      stream.write('event: state\r\ndata: not-json\r\n\r\n');
      stream.write('event: state\r\ndata: {"value":1}\r\n\r\n'); // no id -> ignored
      // A frame split across chunks must survive the internal buffering.
      stream.write('event: state\r\ndata: {"id":"switch-manual_cool');
      await new Promise(resolve => setImmediate(resolve));
      stream.write('ing_enable","state":"ON","value":true}\r\n\r\n');

      while (states.length < 2) await once(client, 'state');

      assert.equal(states.length, 2);
      assert.equal(states[0].id, 'sensor-total_power_input');
      assert.equal(states[0].value, 123.4);
      assert.equal(states[1].id, 'switch-manual_cooling_enable');
      assert.equal(states[1].value, true);
    } finally {
      client.close();
    }
  });
});

test('emits disconnected when the stream ends', async () => {
  let stream;
  await withServer(sseHandler(res => { stream = res; }), async host => {
    const client = new OpenQuattClient(host);
    try {
      client.connect();
      await once(client, 'connected');

      stream.end();
      const [err] = await once(client, 'disconnected');
      assert.match(err.message, /stream ended/);
    } finally {
      client.close();
    }
  });
});

test('commands POST to name-encoded routes with an explicit Content-Length', async () => {
  const handler = (req, res) => {
    res.writeHead(200);
    res.end();
  };
  await withServer(handler, async (host, requests) => {
    const client = new OpenQuattClient(host);
    await client.setSwitch('Manual Cooling Enable', true);
    await client.setSwitch('Aux relay (R2)', false);
    await client.setSelect('Aux Relay Function', 'Heating demand');
    await client.pressButton('Reset Energy');

    assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), [
      'POST /switch/Manual%20Cooling%20Enable/turn_on',
      'POST /switch/Aux%20relay%20(R2)/turn_off',
      'POST /select/Aux%20Relay%20Function/set?option=Heating%20demand',
      'POST /button/Reset%20Energy/press',
    ]);
    // The ESPHome web server answers 411 without this header.
    for (const r of requests) assert.equal(r.headers['content-length'], '0');
  });
});

test('command failures reject with the HTTP status', async () => {
  const handler = (req, res) => {
    res.writeHead(500);
    res.end();
  };
  await withServer(handler, async host => {
    const client = new OpenQuattClient(host);
    await assert.rejects(
      client.setSwitch('Manual Cooling Enable', true),
      /HTTP 500/,
    );
  });
});

test('getEntity returns the parsed entity and rejects on 404', async () => {
  const handler = (req, res) => {
    if (req.url === '/select/Aux%20Relay%20Function') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"select-aux_relay_function","state":"Heating demand"}');
    } else {
      res.writeHead(404);
      res.end();
    }
  };
  await withServer(handler, async host => {
    const client = new OpenQuattClient(host);
    const entity = await client.getEntity('select', 'Aux Relay Function');
    assert.equal(entity.state, 'Heating demand');

    await assert.rejects(client.getEntity('select', 'Nope'), /HTTP 404/);
  });
});
