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
    getSettings() { return this.settings; },
    getRemoteSnapshot: options => ({ name: 'OpenQuatt', options }),
  };
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
