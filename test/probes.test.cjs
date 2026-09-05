/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Worker: NodeWorker } = require('node:worker_threads');
const { test } = require('node:test');
const vm = require('node:vm');
const valuesSource = readFileSync(join(__dirname, 'probe-values.js'), 'utf8');
const driverSource = readFileSync(join(__dirname, 'worker-probes.js'), 'utf8');

function driver(mode = 'ok') {
  const instances = [];
  class Port {
    constructor(owner) { this.owner = owner; this.closed = 0; this.started = 0; }
    start() { this.started++; }
    close() { this.closed++; }
    postMessage(value) {
      assert.equal(value, 'probe');
      this.lastHandler = this.onmessage;
      queueMicrotask(() => {
        if (mode === 'ok') this.onmessage({ data: { type: 'probe', values: { math: 'native-math' } } });
        if (mode === 'error') this.owner.onerror({ message: 'Blocked by CSP', preventDefault() {} });
        if (mode === 'decode') this.onmessageerror();
        if (mode === 'bad-response') this.onmessage({ data: { type: 'unexpected' } });
      });
    }
  }
  class Worker extends Port {
    constructor(url, options) {
      super(null); this.owner = this;
      if (mode === 'constructor') throw new Error('Worker origin is not allowed');
      this.url = url.href; this.options = options; this.terminated = 0; instances.push(this);
    }
    terminate() { this.terminated++; }
  }
  class SharedWorker {
    constructor(url, options) {
      if (mode === 'constructor') throw new Error('Worker origin is not allowed');
      this.url = url.href; this.options = options; this.port = new Port(this); instances.push(this);
    }
  }
  const context = vm.createContext({ URL, Worker: mode === 'absent' ? undefined : Worker,
    SharedWorker: mode === 'absent' ? undefined : SharedWorker,
    location: { href: 'https://example.test/test/selftest.html' }, setTimeout, clearTimeout });
  vm.runInContext(driverSource, context);
  return { instances, run: () => vm.runInContext('probeWorkers(50)', context) };
}

test('worker diagnostic driver selects local classic/module/shared entries and cleans up', async () => {
  const env = driver();
  const results = await env.run();
  assert.deepEqual(Array.from(results, r => r.kind), ['dedicated-classic', 'dedicated-module', 'shared-classic']);
  assert.ok(results.every(r => r.status === 'ok' && r.values.math === 'native-math'));
  assert.equal(env.instances[0].url, 'https://example.test/test/worker-probe.js');
  assert.equal(env.instances[1].url, 'https://example.test/test/worker-probe-module.mjs');
  assert.equal(env.instances[1].options.type, 'module');
  assert.match(env.instances[2].options.name, /^fpd-diagnostic-/);
  assert.equal(env.instances[0].terminated, 1);
  assert.equal(env.instances[1].terminated, 1);
  assert.equal(env.instances[2].port.closed, 1);
  assert.equal(env.instances[2].port.started, 1);
  for (const worker of env.instances) {
    assert.equal(worker.onerror, null);
    assert.equal((worker.port || worker).onmessage, null);
  }
});

for (const mode of ['error', 'decode', 'constructor', 'bad-response', 'timeout', 'absent']) {
  test(`worker ${mode} is reported distinctly, never as protection`, async () => {
    const env = driver(mode);
    const results = await env.run();
    const status = mode === 'timeout' ? 'timeout' : mode === 'absent' ? 'unavailable' : 'error';
    assert.ok(results.every(r => r.status === status && !r.values));
    for (const worker of env.instances) {
      const port = worker.port || worker;
      assert.equal(worker.port ? port.closed : worker.terminated, 1);
      // A late reply must not resolve again or repeat resource cleanup.
      port.lastHandler({ data: { type: 'probe', values: { late: true } } });
      assert.equal(worker.port ? port.closed : worker.terminated, 1);
    }
  });
}

test('passive diagnostic values omit raw device IDs and voice names and never request access', async () => {
  const forbidden = () => { throw new Error('active request must not happen'); };
  const context = vm.createContext({
    document: { fonts: { size: 0, check: () => true } },
    speechSynthesis: { getVoices: () => [{ name: 'SECRET_VOICE_NAME' }], speak: forbidden },
    navigator: {
      language: 'nl-NL', hardwareConcurrency: 12,
      mediaDevices: { enumerateDevices: async () => [{ kind: 'audioinput', label: 'SECRET_LABEL',
        deviceId: 'SECRET_DEVICE_ID', groupId: 'SECRET_GROUP_ID' }], getUserMedia: forbidden },
      permissions: { query: async ({ name }) => {
        if (name === 'geolocation') return { state: 'granted' };
        throw new TypeError('unsupported');
      } }
    },
    Notification: { requestPermission: forbidden }, fetch: forbidden
  });
  vm.runInContext(valuesSource, context);
  const data = await vm.runInContext('__fpdProbeValues()', context);
  assert.equal(data.realm, 'window');
  assert.equal(data.voices, 1);
  assert.equal(data.devices.count, 1);
  assert.equal(data.devices.withDeviceId, 1);
  assert.equal(data.devices.withGroupId, 1);
  assert.equal(data.permissions.geolocation, 'granted');
  assert.equal(data.permissions.camera, 'rejected: TypeError');
  assert.doesNotMatch(JSON.stringify(data), /SECRET_/);
  assert.match(data.math, /^[0-9a-f]{8}$/);
});

test('passive diagnostic failures are not misreported as empty protected lists', async () => {
  const context = vm.createContext({ navigator: { mediaDevices: {
    enumerateDevices: async () => { throw new Error('not fully active'); }
  } } });
  vm.runInContext(valuesSource, context);
  const data = await vm.runInContext('__fpdProbeValues()', context);
  assert.equal(data.devices, 'rejected: Error');
  assert.equal(data.voices, 'unavailable');
  assert.equal(data.permissions, 'unavailable');
  assert.equal(data.canvas, 'unavailable');
});

// Checks the fixture scripts' bootstrap/protocol in an isolated Node worker.
// This is NOT a test of Firefox's loader, CSP, GPU or native SharedWorker ports.
for (const kind of ['classic', 'module', 'shared']) {
  test(`${kind} diagnostic entry bootstraps, replies and exits in a Node harness`, { timeout: 10000 }, async () => {
    const worker = new NodeWorker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      const { resolve } = require('node:path');
      const { pathToFileURL } = require('node:url');
      const vm = require('node:vm');
      globalThis.close = () => parentPort.close();
      globalThis.postMessage = value => parentPort.postMessage(value);
      globalThis.importScripts = file => vm.runInThisContext(readFileSync(resolve(workerData.dir, file), 'utf8'));
      if (workerData.kind === 'shared') globalThis.onconnect = null;
      (async () => {
        if (workerData.kind === 'module') await import(pathToFileURL(resolve(workerData.dir, 'worker-probe-module.mjs')).href);
        else vm.runInThisContext(readFileSync(resolve(workerData.dir, 'worker-probe.js'), 'utf8'));
        if (workerData.kind === 'shared') {
          const port = { postMessage: globalThis.postMessage, start() {}, close() {} };
          globalThis.onconnect({ ports: [port] });
          parentPort.on('message', data => port.onmessage({ data }));
        } else parentPort.on('message', data => globalThis.onmessage({ data }));
        parentPort.postMessage({ type: 'ready' });
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { dir: __dirname, kind } });
    let timer;
    try {
      const message = await new Promise((resolve, reject) => {
        let received = false;
        timer = setTimeout(() => reject(new Error('fixture timed out')), 5000);
        worker.on('message', message => {
          if (message.type === 'ready') worker.postMessage('probe');
          else { received = true; resolve(message); }
        });
        worker.on('error', reject);
        worker.on('exit', code => { if (!received) reject(new Error('fixture exited without a response: ' + code)); });
      });
      assert.equal(message.type, 'probe');
      assert.equal(message.values.realm, 'worker');
      assert.match(message.values.math, /^[0-9a-f]{8}$/);
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  });
}
