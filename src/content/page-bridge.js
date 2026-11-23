/**
 * Content-script side of the page bridge (see src/page/bridge.js).
 *
 * Sends requests to the bridge in WhatsApp's page world over `window.postMessage` and
 * resolves them by request id. `available()` is cheap: the bridge marks the document
 * when it installs, so a page without it is detected without waiting for a timeout.
 */
(function (global) {
  'use strict';

  var WAEx = (global.WAEx = global.WAEx || {});

  var IN = 'wax-content';
  var OUT = 'wax-page';
  var seq = 0;
  var pending = Object.create(null);

  global.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== OUT || !data.reqId || !pending[data.reqId]) return;
    var entry = pending[data.reqId];
    delete pending[data.reqId];
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || 'page bridge error'));
  });

  function available() {
    try {
      return Boolean(global.document && global.document.documentElement.getAttribute('data-wax-bridge'));
    } catch (err) {
      return false;
    }
  }

  function call(type, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var reqId = 'wax-' + Date.now().toString(36) + '-' + ++seq;
      var timer = setTimeout(function () {
        delete pending[reqId];
        reject(new Error('page bridge did not answer ' + type));
      }, timeoutMs || 10000);
      pending[reqId] = { resolve: resolve, reject: reject, timer: timer };
      global.postMessage({ source: IN, type: type, reqId: reqId, payload: payload || null }, '*');
    });
  }

  WAEx.pageBridge = {
    available: available,
    call: call,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
