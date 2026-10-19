'use strict';

const crypto = require('crypto');

// The remote page is reachable from the whole internet, so the login that
// guards it has to be more than a formality.
const MIN_PASSWORD_LENGTH = 8;

// A public endpoint cannot tell callers apart, so failed logins are counted
// across all of them over a sliding window. Past the limit every login is
// refused until the window has moved on; sessions that already exist keep
// working, so a guessing attempt does not lock out a signed-in viewer.
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

// Sessions live in memory only: an app restart signs everyone out.
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;

/**
 * The login remote access is granted with, from a device's settings: the
 * controller login (which only guards the remote page when the controller has
 * none), and only while remote access is switched on and that login is strong
 * enough to face the internet. Null otherwise.
 */
function remoteLogin(settings) {
  if (!settings.remote_enabled) return null;
  const username = settings.web_username || '';
  const password = settings.web_password || '';
  if (!username || password.length < MIN_PASSWORD_LENGTH) return null;
  return { username, password };
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Constant-time, also for inputs of different lengths.
function same(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function fingerprint({ username, password }) {
  return digest(`${username}\0${password}`);
}

/**
 * Logins and sessions for the public remote endpoints. `accounts` lists, on
 * every call, who may sign in right now as `{ key, username, password }`, so
 * switching remote access off, changing the password or removing the device
 * ends its sessions without any further bookkeeping.
 */
class RemoteAccess {

  constructor({ accounts, now = Date.now, log = () => {} }) {
    this._accounts = accounts;
    this._now = now;
    this._log = log;
    this._failures = [];
    this._sessions = new Map();
  }

  login(username, password) {
    const now = this._now();
    this._failures = this._failures.filter(at => now - at < FAILURE_WINDOW_MS);
    if (this._failures.length >= MAX_FAILURES) return { error: 'locked' };

    let match = null;
    if (typeof username === 'string' && typeof password === 'string') {
      // Check every account, so the time taken does not tell which usernames exist.
      for (const account of this._accounts()) {
        const userMatches = same(account.username, username);
        const passwordMatches = same(account.password, password);
        if (userMatches && passwordMatches && !match) match = account;
      }
    }

    if (!match) {
      this._failures.push(now);
      if (this._failures.length === MAX_FAILURES) {
        this._log(`remote: ${MAX_FAILURES} failed logins, refusing logins for a while`);
      }
      return { error: 'unauthorized' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    this._sessions.set(token, { key: match.key, fingerprint: fingerprint(match), lastUsed: now });
    // The map keeps insertion order and every use re-inserts, so the first
    // entry is the least recently used one.
    while (this._sessions.size > MAX_SESSIONS) {
      this._sessions.delete(this._sessions.keys().next().value);
    }
    return { token };
  }

  /**
   * The key of the account a session belongs to, or null when the token is
   * unknown, idle for too long, or its account no longer grants access with
   * the login the session was opened with.
   */
  session(token) {
    const session = typeof token === 'string' ? this._sessions.get(token) : undefined;
    if (!session) return null;

    const now = this._now();
    const account = this._accounts().find(candidate => candidate.key === session.key);
    if (now - session.lastUsed > SESSION_IDLE_MS
      || !account
      || !crypto.timingSafeEqual(fingerprint(account), session.fingerprint)) {
      this._sessions.delete(token);
      return null;
    }

    session.lastUsed = now;
    this._sessions.delete(token);
    this._sessions.set(token, session);
    return account.key;
  }

  logout(token) {
    if (typeof token === 'string') this._sessions.delete(token);
  }

}

module.exports = {
  RemoteAccess,
  remoteLogin,
  MIN_PASSWORD_LENGTH,
};
