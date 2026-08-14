'use strict';

// Redirect `require('homey')` to the stub so app code can be loaded outside
// the Homey runtime. Require this helper before requiring any app module.
const Module = require('module');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request, ...args) {
  if (request === 'homey') return require.resolve('../stubs/homey');
  return originalResolve.call(this, request, ...args);
};
