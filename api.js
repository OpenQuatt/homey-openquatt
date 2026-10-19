'use strict';

// Public endpoints for the remote page (docs/remote), reached through the
// Homey's cloud connection. They are public because the page has no Homey
// account to sign in with: lib/RemoteAccess guards them with the controller's
// own login instead. Errors are answered as { error } with HTTP 200, so the
// page does not depend on how Homey maps thrown errors to status codes.
module.exports = {

  async remoteLogin({ homey, body }) {
    const { username, password } = body || {};
    return homey.app.remote.login(username, password);
  },

  async remoteState({ homey, body }) {
    const { token, entities } = body || {};
    const device = homey.app.remote.session(token);
    if (!device) return { error: 'unauthorized' };
    return { state: device.getRemoteSnapshot({ entities: entities === true }) };
  },

  async remoteLogout({ homey, body }) {
    homey.app.remote.logout((body || {}).token);
    return {};
  },

};
