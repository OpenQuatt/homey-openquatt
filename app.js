'use strict';

const Homey = require('homey');

class OpenQuattApp extends Homey.App {

  async onInit() {
    this.log('OpenQuatt app started');
  }

}

module.exports = OpenQuattApp;
