'use strict';

const Homey = require('homey');
const { RemoteAccess, remoteLogin } = require('./lib/RemoteAccess');

class OpenQuattApp extends Homey.App {

  async onInit() {
    // Every controller with remote access switched on can be signed into with
    // its own login; the session then resolves to that device.
    this.remote = new RemoteAccess({
      accounts: () => this.homey.drivers.getDriver('openquatt').getDevices()
        .map(device => ({ key: device, ...remoteLogin(device.getSettings()) }))
        .filter(account => account.username),
      log: message => this.log(message),
    });

    this.log('OpenQuatt app started');
  }

}

module.exports = OpenQuattApp;
