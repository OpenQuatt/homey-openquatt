'use strict';

require('./helpers/require-homey');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const OpenQuattApp = require('../app');
const api = require('../api');

// The app wired to fake devices, as the public endpoints see it.
async function makeHomey(devices) {
  const app = Object.create(OpenQuattApp.prototype);
  app.homey = { drivers: { getDriver: () => ({ getDevices: () => devices }) } };
  app.log = () => {};
  await app.onInit();
  return { app };
}

function fakeDevice(settings) {
  return {
    settings,
    energyRanges: [],
    getSettings() { return this.settings; },
    getRemoteSnapshot: options => ({ name: 'OpenQuatt', options }),
    getRemoteHistory: () => ({ rows: [] }),
    async getEnergyHistory(range) {
      this.energyRanges.push(range);
      if (this.energyFails) throw new Error('HTTP 404 on /energy/history');
      return { days: [], hours: [] };
    },
  };
}

async function signIn(homey) {
  const { token } = await api.remoteLogin({ homey, body: { username: 'admin', password: 'correct-horse' } });
  return token;
}

const ENABLED = { remote_enabled: true, web_username: 'admin', web_password: 'correct-horse' };

test('signing in returns a token that reads the state of that device', async () => {
  const homey = await makeHomey([fakeDevice(ENABLED)]);

  const { token } = await api.remoteLogin({ homey, body: { username: 'admin', password: 'correct-horse' } });
  assert.ok(token);

  assert.deepEqual(await api.remoteState({ homey, body: { token } }), {
    state: { name: 'OpenQuatt', options: { entities: false } },
  });
  assert.deepEqual(await api.remoteState({ homey, body: { token, entities: true } }), {
    state: { name: 'OpenQuatt', options: { entities: true } },
  });
});

test('a device without remote access cannot be signed into', async () => {
  const homey = await makeHomey([fakeDevice({ ...ENABLED, remote_enabled: false })]);
  assert.deepEqual(
    await api.remoteLogin({ homey, body: { username: 'admin', password: 'correct-horse' } }),
    { error: 'unauthorized' },
  );
});

test('switching remote access off ends running sessions', async () => {
  const device = fakeDevice(ENABLED);
  const homey = await makeHomey([device]);
  const { token } = await api.remoteLogin({ homey, body: { username: 'admin', password: 'correct-horse' } });

  device.settings = { ...ENABLED, remote_enabled: false };
  assert.deepEqual(await api.remoteState({ homey, body: { token } }), { error: 'unauthorized' });
});

test('state needs a token, and logout ends it', async () => {
  const homey = await makeHomey([fakeDevice(ENABLED)]);
  assert.deepEqual(await api.remoteState({ homey, body: undefined }), { error: 'unauthorized' });

  const { token } = await api.remoteLogin({ homey, body: { username: 'admin', password: 'correct-horse' } });
  assert.deepEqual(await api.remoteLogout({ homey, body: { token } }), {});
  assert.deepEqual(await api.remoteState({ homey, body: { token } }), { error: 'unauthorized' });
});

test('state carries the entities asked for: all, a list, or none', async () => {
  const homey = await makeHomey([fakeDevice(ENABLED)]);
  const token = await signIn(homey);
  const options = async entities => (await api.remoteState({ homey, body: { token, entities } })).state.options;

  assert.deepEqual(await options(true), { entities: true });
  assert.deepEqual(await options(['sensor-a', 'text_sensor-b']), { entities: ['sensor-a', 'text_sensor-b'] });
  // Anything else asks for none.
  assert.deepEqual(await options('all'), { entities: false });
  assert.deepEqual(await options([1, 2]), { entities: false });
  assert.deepEqual(await options(new Array(401).fill('sensor-a')), { entities: false });
});

test('history and energy need a session', async () => {
  const homey = await makeHomey([fakeDevice(ENABLED)]);
  assert.deepEqual(await api.remoteHistory({ homey, body: { token: 'nope' } }), { error: 'unauthorized' });
  assert.deepEqual(
    await api.remoteEnergy({ homey, body: { token: 'nope', from: 20261019, to: 20261019 } }),
    { error: 'unauthorized' },
  );

  const token = await signIn(homey);
  assert.deepEqual(await api.remoteHistory({ homey, body: { token } }), { history: { rows: [] } });
});

test('energy passes a checked range on, and reports a controller without history', async () => {
  const device = fakeDevice(ENABLED);
  const homey = await makeHomey([device]);
  const token = await signIn(homey);

  assert.deepEqual(
    await api.remoteEnergy({
      homey,
      body: {
        token, from: 20261013, to: 20261019, hours: true,
      },
    }),
    { energy: { days: [], hours: [] } },
  );
  assert.deepEqual(device.energyRanges, [{ from: 20261013, to: 20261019, hours: true }]);

  assert.deepEqual(
    await api.remoteEnergy({
      homey,
      body: {
        token, from: 20261001, to: 20261019, hours: true,
      },
    }),
    { error: 'invalid' },
  );

  device.energyFails = true;
  assert.deepEqual(
    await api.remoteEnergy({ homey, body: { token, from: 20261019, to: 20261019 } }),
    { error: 'unavailable' },
  );
});
