'use strict';

// Minimal stand-in for the `homey` module, which only exists on the Homey
// runtime itself. Loaded through the resolver hook in test/helpers/require-homey.js.
class SimpleClass {
  log() {}

  error() {}
}

module.exports = {
  App: class App extends SimpleClass {},
  Driver: class Driver extends SimpleClass {},
  Device: class Device extends SimpleClass {},
};
