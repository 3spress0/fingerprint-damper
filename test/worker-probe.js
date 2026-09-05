/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Diagnostic worker only. The module entry imports the values module first;
// classic dedicated/shared workers load the same local code with importScripts.
if (!globalThis.__fpdProbeValues) importScripts('./probe-values.js');
async function answer(port) {
  try { port.postMessage({ type: 'probe', values: await globalThis.__fpdProbeValues() }); }
  catch (e) { port.postMessage({ type: 'error', message: String(e && e.message || e) }); }
  finally {
    if (port !== globalThis && port.close) port.close();
    globalThis.close(); // each uniquely named diagnostic worker serves one request
  }
}
if ('onconnect' in globalThis) {
  globalThis.onconnect = event => {
    const port = event.ports[0];
    port.onmessage = event => { if (event.data === 'probe') answer(port); };
    port.start();
  };
} else {
  globalThis.onmessage = event => { if (event.data === 'probe') answer(globalThis); };
}
