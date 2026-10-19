'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RemoteAccess, remoteLogin } = require('../lib/RemoteAccess');

const DAY = 24 * 60 * 60 * 1000;

// A clock and account list the tests control.
function makeRemote(accounts = [{ key: 'dev1', username: 'admin', password: 'correct-horse' }]) {
  const clock = { now: 0 };
  const logs = [];
  const remote = new RemoteAccess({
    accounts: () => accounts,
    now: () => clock.now,
    log: message => logs.push(message),
  });
  return {
    remote, clock, accounts, logs,
  };
}

test('remoteLogin only grants access when switched on with a strong login', () => {
  const base = { remote_enabled: true, web_username: 'admin', web_password: 'correct-horse' };
  assert.deepEqual(remoteLogin(base), { username: 'admin', password: 'correct-horse' });
  assert.equal(remoteLogin({ ...base, remote_enabled: false }), null);
  assert.equal(remoteLogin({ ...base, web_username: '' }), null);
  assert.equal(remoteLogin({ ...base, web_password: 'short' }), null);
  assert.equal(remoteLogin({ ...base, web_password: undefined }), null);
});

test('a correct login opens a session that resolves to its account', () => {
  const { remote } = makeRemote();
  const { token } = remote.login('admin', 'correct-horse');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(remote.session(token), 'dev1');
});

test('a wrong login, or one of the wrong type, is refused', () => {
  const { remote } = makeRemote();
  assert.deepEqual(remote.login('admin', 'wrong'), { error: 'unauthorized' });
  assert.deepEqual(remote.login('nobody', 'correct-horse'), { error: 'unauthorized' });
  assert.deepEqual(remote.login(undefined, undefined), { error: 'unauthorized' });
  assert.deepEqual(remote.login({}, ['correct-horse']), { error: 'unauthorized' });
});

test('no account means no login at all', () => {
  const { remote } = makeRemote([]);
  assert.deepEqual(remote.login('', ''), { error: 'unauthorized' });
});

test('each account signs in with its own login', () => {
  const { remote } = makeRemote([
    { key: 'dev1', username: 'admin', password: 'correct-horse' },
    { key: 'dev2', username: 'holiday', password: 'battery-staple' },
  ]);
  assert.equal(remote.session(remote.login('holiday', 'battery-staple').token), 'dev2');
  assert.deepEqual(remote.login('holiday', 'correct-horse'), { error: 'unauthorized' });
});

test('too many failures lock logins, but not existing sessions', () => {
  const { remote, clock, logs } = makeRemote();
  const { token } = remote.login('admin', 'correct-horse');

  for (let i = 0; i < 10; i++) {
    assert.deepEqual(remote.login('admin', `guess-${i}`), { error: 'unauthorized' });
    clock.now += 1000;
  }
  assert.equal(logs.length, 1);

  // Even the right password is refused while locked, or guessing would go on.
  assert.deepEqual(remote.login('admin', 'correct-horse'), { error: 'locked' });
  assert.equal(remote.session(token), 'dev1');

  // The window slides: once the oldest failure is out of it, logins work again.
  clock.now = 15 * 60 * 1000;
  assert.ok(remote.login('admin', 'correct-horse').token);
});

test('a changed password or switched-off access ends the session', () => {
  const { remote, accounts } = makeRemote();
  const first = remote.login('admin', 'correct-horse').token;
  accounts[0] = { ...accounts[0], password: 'another-password' };
  assert.equal(remote.session(first), null);
  // The session is gone for good, even if the old password comes back.
  accounts[0] = { ...accounts[0], password: 'correct-horse' };
  assert.equal(remote.session(first), null);

  const second = remote.login('admin', 'correct-horse').token;
  accounts.length = 0;
  assert.equal(remote.session(second), null);
});

test('a session expires after a month without use, and use keeps it alive', () => {
  const { remote, clock } = makeRemote();
  const kept = remote.login('admin', 'correct-horse').token;
  const idle = remote.login('admin', 'correct-horse').token;

  clock.now = 20 * DAY;
  assert.equal(remote.session(kept), 'dev1');
  clock.now = 40 * DAY;
  assert.equal(remote.session(kept), 'dev1');
  assert.equal(remote.session(idle), null);
});

test('logout ends the session; unknown tokens resolve to nothing', () => {
  const { remote } = makeRemote();
  const { token } = remote.login('admin', 'correct-horse');
  remote.logout(token);
  assert.equal(remote.session(token), null);
  assert.equal(remote.session('0'.repeat(64)), null);
  assert.equal(remote.session(undefined), null);
  assert.doesNotThrow(() => remote.logout(undefined));
});

test('the least recently used session makes way past the limit', () => {
  const { remote, clock } = makeRemote();
  const tokens = [];
  for (let i = 0; i < 20; i++) {
    tokens.push(remote.login('admin', 'correct-horse').token);
    clock.now += 1;
  }
  // Using the oldest one makes the second the least recently used.
  assert.equal(remote.session(tokens[0]), 'dev1');
  remote.login('admin', 'correct-horse');

  assert.equal(remote.session(tokens[0]), 'dev1');
  assert.equal(remote.session(tokens[1]), null);
  assert.equal(remote.session(tokens[2]), 'dev1');
});
