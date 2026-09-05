/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Window-side diagnostic driver. Does not patch Worker/SharedWorker, intercept
// site workers or attempt to inject the extension into another global.
async function probeWorkers(timeoutMs = 5000) {
  const specs = [
    { kind: 'dedicated-classic', ctor: globalThis.Worker, file: 'worker-probe.js' },
    { kind: 'dedicated-module', ctor: globalThis.Worker, file: 'worker-probe-module.mjs', options: { type: 'module' } },
    { kind: 'shared-classic', ctor: globalThis.SharedWorker, file: 'worker-probe.js',
      options: { name: 'fpd-diagnostic-' + Date.now() + '-' + Math.random().toString(36).slice(2) } }
  ];
  return Promise.all(specs.map(spec => new Promise(resolve => {
    if (typeof spec.ctor !== 'function') { resolve({ kind: spec.kind, status: 'unavailable' }); return; }
    let worker, port, timer, finished = false;
    const finish = (status, detail = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (port) { port.onmessage = null; port.onmessageerror = null; }
      if (worker) {
        worker.onerror = null;
        try { if (worker.terminate) worker.terminate(); else if (port) port.close(); } catch (_) {}
      }
      resolve({ kind: spec.kind, status, ...detail });
    };
    timer = setTimeout(() => finish('timeout', { message: 'No reply; do not interpret this as protection.' }), timeoutMs);
    try {
      worker = new spec.ctor(new URL(spec.file, location.href), spec.options);
      port = worker.port || worker;
      worker.onerror = event => {
        if (event.preventDefault) event.preventDefault();
        finish('error', { message: event.message || 'Worker load/execution failed (possibly origin or CSP policy).' });
      };
      port.onmessageerror = () => finish('error', { message: 'Worker response could not be decoded.' });
      port.onmessage = event => {
        if (event.data && event.data.type === 'probe') finish('ok', { values: event.data.values });
        else finish('error', { message: event.data && event.data.message || 'Unexpected worker response.' });
      };
      if (port.start) port.start();
      port.postMessage('probe');
    } catch (e) { finish('error', { message: String(e && e.message || e) }); }
  })));
}
