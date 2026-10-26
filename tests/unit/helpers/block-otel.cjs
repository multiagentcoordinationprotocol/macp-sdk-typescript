// Preload for the otel_absent_no_import child process (tests/unit/otel.test.ts):
// makes every `@opentelemetry/*` specifier unresolvable, exactly as when the
// optional peer dependency is not installed, and counts the require() calls
// that asked for one (not resolver passes: a loader may resolve several
// candidate paths for one require).
const Module = require('node:module');

const blocked = (request) => typeof request === 'string' && request.startsWith('@opentelemetry/');

globalThis.__otelRequireCalls = 0;
const originalRequire = Module.prototype.require;
Module.prototype.require = function (request, ...rest) {
  if (blocked(request)) globalThis.__otelRequireCalls += 1;
  return originalRequire.call(this, request, ...rest);
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (blocked(request)) {
    const error = new Error(`Cannot find module '${request}'`);
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return originalResolve.call(this, request, ...rest);
};
