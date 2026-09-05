/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const vm = require('node:vm');
const { createFixture, serverCSP, probeCode, workerCode, sharedCode, page } = require('./lockdown-server.cjs');

// These tests check the local fixture, NOT Firefox's policy enforcement.
test('HTTP fixture provides uncached server-CSP controls and logs no raw identifiers', async t => {
  const server = createFixture();
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(base + '/?SECRET_QUERY=1', { headers: {
    cookie: '__fpd_lockdown_probe=1; real=SECRET_COOKIE', 'user-agent': 'SECRET_AGENT',
    authorization: 'Bearer SECRET_TOKEN', referer: 'https://site.test/SECRET_REFERRER'
  } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-security-policy'), serverCSP);
  assert.equal(response.headers.get('set-cookie'), null, 'ordinary probe load must not set cookies');
  assert.match(await response.text(), /DID NOT RUN/);
  const prime = await fetch(base + '/prime-cookie');
  assert.match(prime.headers.get('set-cookie'), /^__fpd_lockdown_probe=1;/);
  await prime.text();
  const data = await (await fetch(base + '/events')).text();
  assert.doesNotMatch(data, /SECRET_|Authorization|Bearer/);
  const first = JSON.parse(data)[0];
  assert.equal(first.path, '/');
  assert.equal(first.probeCookie, true);
  assert.equal(first.userAgentPresent, true);
  assert.equal(first.refererPresent, true);
  for (const path of ['/probe.js', '/worker.js', '/module.mjs', '/shared.js']) {
    const asset = await fetch(base + path);
    assert.equal(asset.headers.get('content-type'), 'text/javascript');
    const source = await asset.text();
    assert.doesNotThrow(() => new vm.Script(source));
  }
  const missing = await fetch(base + '/../.git/config');
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'Not found');
});

test('all generated probe scripts parse and perform no automatic SW registration or capture', () => {
  for (const code of [probeCode, workerCode, sharedCode]) new vm.Script(code);
  for (const [, code] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(code);
  assert.doesNotMatch(probeCode, /serviceWorker\.register|getUserMedia|requestPermission|speechSynthesis/);
  assert.match(probeCode, /URL\.revokeObjectURL/);
  assert.match(probeCode, /worker\.terminate/);
  assert.match(sharedCode, /port\.close/);
});
