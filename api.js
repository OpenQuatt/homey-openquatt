'use strict';

const { energyHistoryRange } = require('./lib/energyHistory');

// The most entity ids one state request may name; the page asks for a few
// dozen per tab, or for all of them with `true`.
const MAX_ENTITY_IDS = 400;

// Public endpoints for the remote page (docs/remote), reached through the
// Homey's cloud connection. They are public because the page has no Homey
// account to sign in with: lib/RemoteAccess guards them with the login from
// the device settings instead. Errors are answered as { error } with HTTP 200,
// so the page does not depend on how Homey maps thrown errors to status codes.
// Everything here only reads.

function entityRequest(entities) {
  if (entities === true) return true;
  if (Array.isArray(entities) && entities.length <= MAX_ENTITY_IDS
    && entities.every(id => typeof id === 'string' && id.length <= 120)) return entities;
  return false;
}

module.exports = {

  async remoteLogin({ homey, body }) {
    const { username, password } = body || {};
    return homey.app.remote.login(username, password);
  },

  async remoteState({ homey, body }) {
    const { token, entities } = body || {};
    const device = homey.app.remote.session(token);
    if (!device) return { error: 'unauthorized' };
    const request = entityRequest(entities);
    await device.refreshPolledEntities(request);
    return { state: device.getRemoteSnapshot({ entities: request }) };
  },

  async remoteHistory({ homey, body }) {
    const device = homey.app.remote.session((body || {}).token);
    if (!device) return { error: 'unauthorized' };
    return { history: device.getRemoteHistory() };
  },

  async remoteEnergy({ homey, body }) {
    const {
      token, from, to, hours,
    } = body || {};
    const device = homey.app.remote.session(token);
    if (!device) return { error: 'unauthorized' };
    const range = energyHistoryRange(from, to, hours);
    if (!range) return { error: 'invalid' };
    try {
      return { energy: await device.getEnergyHistory(range) };
    } catch (err) {
      // Typically: the controller is unreachable, or its firmware keeps no
      // energy history (404).
      return { error: 'unavailable' };
    }
  },

  async remoteLogout({ homey, body }) {
    homey.app.remote.logout((body || {}).token);
    return {};
  },

};
