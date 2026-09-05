/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const core = readFileSync(join(__dirname, '../src/lockdown.js'), 'utf8');
const background = readFileSync(join(__dirname, '../src/background.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const ctx = vm.createContext({});
vm.runInContext(core, ctx);
const policy = ctx.FPDLockdown;
const all = Object.fromEntries(policy.keys.map(key => [key, true]));
const rules = settings => clone(policy.buildRules(settings));
const csp = settings => rules(settings).flatMap(rule => rule.action.responseHeaders || [])
  .find(header => header.header === 'content-security-policy')?.value;
// Model ONLY these generated conditions, not Firefox's complete DNR matcher.
const matches = (rule, url, type) => new RegExp(rule.condition.regexFilter, 'i').test(url) &&
  (!rule.condition.resourceTypes || rule.condition.resourceTypes.includes(type)) &&
  !rule.condition.excludedResourceTypes?.includes(type);
const blocked = (settings, url, type) => rules(settings).some(rule => rule.action.type === 'block' && matches(rule, url, type));

test('all eight lockdown controls default off and install no rules', () => {
  assert.equal(policy.keys.length, 8);
  assert.ok(Object.values(policy.defaults).every(value => value === false));
  assert.deepEqual(rules(), []);
  assert.deepEqual(rules(policy.defaults), []);
  assert.deepEqual(rules({ lockScripts: 'true', lockCookies: 1 }), []);
});

test('script denial covers inline policy, workers and HTTP script requests', () => {
  assert.match(csp({ lockScripts: true }), /script-src 'none'/);
  assert.match(csp({ lockScripts: true }), /worker-src 'none'/);
  assert.equal(blocked({ lockScripts: true }, 'https://site.test/worker.js', 'script'), true);
  assert.equal(blocked({ lockScripts: true }, 'https://site.test/', 'main_frame'), false);
  assert.equal(blocked({ lockScripts: true }, 'https://site.test/image.png', 'image'), false);
});

test('sandbox has no script/origin escape tokens and restricts forms and embeds', () => {
  const value = csp({ lockSandbox: true });
  assert.ok(value.split('; ').includes('sandbox'));
  assert.doesNotMatch(value, /allow-/);
  for (const directive of ['script-src', 'worker-src', 'object-src', 'frame-src', 'form-action', 'base-uri']) {
    assert.ok(value.includes(directive + " 'none'"));
  }
});

test('worker-only and embed-only controls do not masquerade as global script denial', () => {
  assert.equal(csp({ lockWorkers: true }), "worker-src 'none'");
  assert.equal(rules({ lockWorkers: true }).length, 1);
  assert.doesNotMatch(csp({ lockEmbeds: true }), /script-src|worker-src|child-src/);
  assert.equal(blocked({ lockEmbeds: true }, 'https://site.test/frame', 'sub_frame'), true);
  assert.equal(blocked({ lockEmbeds: true }, 'https://site.test/code.js', 'script'), false);
});

test('connection denial includes Firefox beacons and WS(S), not just ping or HTTP', () => {
  for (const type of ['xmlhttprequest', 'websocket', 'beacon', 'ping', 'csp_report']) {
    for (const scheme of ['http', 'https', 'ws', 'wss']) {
      assert.equal(blocked({ lockConnect: true }, scheme + '://site.test/', type), true);
    }
  }
  assert.equal(blocked({ lockConnect: true }, 'https://site.test/pixel', 'image'), false);
});

test('text-only seal blocks secondary resource types but deliberately permits initial navigation', () => {
  for (const type of ['script', 'json', 'sub_frame', 'stylesheet', 'image', 'imageset', 'font', 'media',
    'web_manifest', 'object', 'object_subrequest', 'xmlhttprequest', 'websocket', 'speculative', 'other']) {
    assert.equal(blocked({ lockResources: true }, 'https://site.test/', type), true, type);
  }
  assert.equal(blocked({ lockResources: true }, 'https://site.test/', 'main_frame'), false);
  assert.match(csp({ lockResources: true }), /default-src 'none'; style-src 'unsafe-inline'/);
  for (const scheme of ['moz-extension', 'about', 'file', 'data', 'blob']) {
    assert.equal(blocked(all, scheme + '://site.test/', 'script'), false);
  }
});

test('cookie removal is both directions and header minimization does not strip security headers', () => {
  const cookie = rules({ lockCookies: true })[0];
  assert.deepEqual(cookie.action.requestHeaders, [{ header: 'cookie', operation: 'remove' }]);
  assert.deepEqual(cookie.action.responseHeaders, [{ header: 'set-cookie', operation: 'remove' }]);
  const identity = rules({ lockHeaders: true })[0];
  assert.ok(identity.action.requestHeaders.some(h => h.header === 'user-agent'));
  assert.ok(identity.action.requestHeaders.some(h => h.header === 'referer'));
  for (const header of ['origin', 'authorization', 'host', 'sec-fetch-site', 'cookie']) {
    assert.ok(identity.action.requestHeaders.every(h => h.header !== header));
  }
  assert.deepEqual(identity.action.responseHeaders, [{ header: 'referrer-policy', operation: 'set', value: 'no-referrer' }]);
});

test('every combination composes at most three rules without replacing server CSP or adding allow rules', () => {
  for (let mask = 0; mask < 256; mask++) {
    const selected = Object.fromEntries(policy.keys.map((key, i) => [key, !!(mask & (1 << i))]));
    const result = rules(selected);
    assert.ok(result.length <= 3);
    assert.equal(new Set(result.map(r => r.id)).size, result.length);
    for (const rule of result) {
      assert.ok(policy.ruleIds.includes(rule.id));
      assert.ok(['block', 'modifyHeaders'].includes(rule.action.type));
      assert.ok(!rule.condition.excludedRequestDomains && !rule.condition.excludedInitiatorDomains);
      for (const header of rule.action.responseHeaders || []) {
        if (header.header === 'content-security-policy') {
          assert.equal(header.operation, 'append');
          assert.deepEqual(rule.condition.resourceTypes, ['main_frame', 'sub_frame']);
          assert.equal(new Set(header.value.split('; ')).size, header.value.split('; ').length);
        }
      }
    }
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const UI = { id: 'fingerprint-damper@local', url: 'moz-extension://unit/src/options.html' };
const PAGE = { id: UI.id, url: 'https://site.test/path', tab: { id: 7, url: 'https://site.test/path' } };
const unrelated = { id: 99999, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'untouched.test' } };
function setup(options = {}) {
  const state = options.state || { settings: options.settings || {}, allowlist: [],
    dynamic: [clone(unrelated)], enabled: ['adnets', 'unrelated-ruleset'] };
  const calls = [], writes = [], events = {}, failures = options.failures || {};
  async function operation(name, args) {
    calls.push({ name, args: clone(args || {}) });
    const step = failures[name]?.shift();
    if (step instanceof Error) throw step;
    if (typeof step === 'function') await step();
  }
  const browser = {
    runtime: { id: UI.id, getURL: path => 'moz-extension://unit/' + path,
      onMessage: { addListener: fn => { events.message = fn; } },
      onInstalled: { addListener: fn => { events.installed = fn; } } },
    storage: { local: {
      async get(key) { await operation('get', { key }); return { [key]: clone(state[key] ?? {}) }; },
      async set(value) { await operation('set', value); Object.assign(state, clone(value)); writes.push(clone(value)); }
    } },
    declarativeNetRequest: {
      async getDynamicRules() { await operation('getDynamicRules'); return clone(state.dynamic); },
      async getEnabledRulesets() { await operation('getEnabledRulesets'); return [...state.enabled]; },
      async updateDynamicRules(change) {
        await operation('updateDynamicRules', change);
        state.dynamic = state.dynamic.filter(rule => !change.removeRuleIds.includes(rule.id)).concat(clone(change.addRules));
      },
      async updateEnabledRulesets(change) {
        await operation('updateEnabledRulesets', change);
        state.enabled = state.enabled.filter(id => !change.disableRulesetIds?.includes(id));
        state.enabled = [...new Set(state.enabled.concat(change.enableRulesetIds || []))];
      }
    },
    tabs: { async query() { await operation('tabs.query'); return [PAGE.tab]; },
      async sendMessage() {},
      onRemoved: { addListener: fn => { events.removed = fn; } },
      onUpdated: { addListener: fn => { events.updated = fn; } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  const context = vm.createContext({ browser, URL });
  vm.runInContext(core, context);
  vm.runInContext(background, context);
  const send = (msg, sender = UI) => events.message(msg, sender);
  return { state, calls, writes, events, failures, send,
    ready: () => send({ type: 'popupData' }), settings: patch => send({ type: 'setSettings', settings: patch }) };
}

test('background migration keeps existing settings and all lockdown controls off', async () => {
  const env = setup({ settings: { mathRounding: true, canvas: false, lockScripts: 'true' } });
  const data = await env.ready();
  assert.equal(data.settings.mathRounding, true);
  assert.equal(data.settings.canvas, false);
  assert.ok(policy.keys.every(key => data.settings[key] === false));
  assert.equal(data.policyStatus.state, 'synced');
  assert.equal(data.policyStatus.ruleCount, 0);
  assert.deepEqual(env.state.dynamic, [unrelated]);
  assert.equal(env.calls.filter(c => c.name === 'updateDynamicRules').length, 0);
});

test('enable, persist, restart, upgrade and disable preserve unrelated settings/rules', async () => {
  const env = setup({ settings: { canvas: false } });
  await env.ready();
  assert.equal((await env.settings({ ...all, netBlock: false })).ok, true);
  assert.equal(env.state.dynamic.length, 4);
  const restarted = setup({ state: env.state });
  await restarted.ready();
  assert.equal(restarted.calls.filter(c => c.name === 'updateDynamicRules').length, 0);
  // Manifest-enabled static rules can be reset on extension update.
  restarted.state.enabled.push('adnets');
  await restarted.events.installed();
  assert.ok(!restarted.state.enabled.includes('adnets'));
  assert.ok(restarted.state.enabled.includes('unrelated-ruleset'));
  assert.equal((await restarted.send({ type: 'disableLockdown' })).ok, true);
  assert.deepEqual(restarted.state.dynamic, [unrelated]);
  assert.ok(policy.keys.every(key => restarted.state.settings[key] === false));
  assert.equal(restarted.state.settings.canvas, false);
  assert.equal(restarted.state.settings.netBlock, false);
});

test('global policy is not exempted by per-origin API pause', async () => {
  const env = setup();
  await env.ready();
  await env.settings(all);
  const before = clone(env.state.dynamic);
  const result = await env.send({ type: 'toggleAllowlist', origin: 'https://site.test' });
  assert.equal(result.allowlisted, true);
  assert.deepEqual(env.state.dynamic, before);
  const config = await env.send({ type: 'getConfig', href: 'https://forged.test/' }, PAGE);
  assert.equal(config.allowlisted, true);
  assert.ok(policy.keys.every(key => !Object.hasOwn(config.settings, key)));
});

test('privileged messages reject content scripts and misleading extension URLs', async () => {
  const env = setup();
  await env.ready();
  for (const sender of [PAGE, { ...UI, id: 'other-extension' },
    { ...UI, url: 'moz-extension://unit.attacker/src/options.html' }, { ...UI, url: 'https://site.test/moz-extension://unit/' }]) {
    for (const type of ['setSettings', 'disableLockdown', 'toggleAllowlist', 'popupData']) {
      assert.equal((await env.send({ type, settings: all, origin: 'https://site.test' }, sender)).ok, false);
    }
  }
  assert.deepEqual(env.state.dynamic, [unrelated]);
  assert.equal(env.writes.length, 0);
});

test('only known boolean settings and canonical allowlist origins can be written', async () => {
  const env = setup();
  await env.ready();
  for (const patch of [null, [], { lockScripts: 'true' }, { surprise: true }, JSON.parse('{"__proto__":{}}')]) {
    assert.equal((await env.settings(patch)).ok, false);
  }
  assert.equal((await env.send({ type: 'toggleAllowlist', origin: 'https://site.test/path' })).ok, false);
  assert.equal(env.writes.length, 0);
});

test('concurrent enables and emergency off are serialized with no lost updates', async () => {
  const env = setup();
  await env.ready();
  const started = deferred(), release = deferred();
  env.failures.updateDynamicRules = [async () => { started.resolve(); await release.promise; }];
  const a = env.settings({ lockScripts: true });
  await started.promise;
  const b = env.settings({ lockCookies: true });
  const c = env.send({ type: 'disableLockdown' });
  assert.equal(env.writes.length, 0);
  release.resolve();
  assert.ok((await Promise.all([a, b, c])).every(result => result.ok));
  assert.equal(env.writes[1].settings.lockScripts, true);
  assert.equal(env.writes[1].settings.lockCookies, true);
  assert.deepEqual(env.state.dynamic, [unrelated]);
  assert.ok(policy.keys.every(key => env.state.settings[key] === false));
});

for (const name of ['updateDynamicRules', 'updateEnabledRulesets', 'set']) {
  test(`${name} rejection cannot report a saved lockdown or leave partial policy silently`, async () => {
    const env = setup();
    await env.ready();
    env.failures[name] = [new Error('simulated failure')];
    const result = await env.settings({ ...all, netBlock: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /Previous network rules restored/);
    assert.deepEqual(env.state.dynamic, [unrelated]);
    assert.ok(env.state.enabled.includes('adnets'));
    assert.equal(env.writes.length, 0);
    assert.equal((await env.ready()).policyStatus.state, 'error');
    assert.equal((await env.settings(all)).ok, true, 'queue must recover after rejection');
  });
}

test('rollback failure is explicit and emergency off can remove stale rules', async () => {
  const env = setup();
  await env.ready();
  env.failures.updateDynamicRules = [null, new Error('rollback unavailable')];
  env.failures.set = [new Error('storage unavailable')];
  const result = await env.settings(all);
  assert.equal(result.ok, false);
  assert.match(result.error, /ROLLBACK FAILED/);
  assert.equal((await env.ready()).policyStatus.ruleCount, null);
  assert.equal(env.state.dynamic.length, 4);
  assert.equal((await env.send({ type: 'disableLockdown' })).ok, true);
  assert.deepEqual(env.state.dynamic, [unrelated]);
});

test('startup failures are visible and stale owned rules are reconciled on a later start', async () => {
  const env = setup({ failures: { getDynamicRules: [new Error('DNR unavailable')] } });
  assert.equal((await env.ready()).policyStatus.state, 'error');
  env.state.dynamic.push(...rules(all));
  const restarted = setup({ state: env.state });
  assert.equal((await restarted.ready()).policyStatus.state, 'synced');
  assert.deepEqual(env.state.dynamic, [unrelated]);
});

test('untrusted page stats accept bounded numeric known counters only and reset on reload', async () => {
  const env = setup();
  await env.ready();
  for (const counts of [null, 'invalid', { canvas: Infinity, audio: -1 },
    JSON.parse('{"__proto__":{"bad":true},"lockScripts":999,"canvas":4}')]) {
    await env.send({ type: 'stats', counts, href: 'https://forged.test' }, PAGE);
  }
  const data = await env.ready();
  assert.equal(data.origin, 'https://site.test');
  assert.deepEqual(clone(data.counts), { canvas: 4 });
  env.events.updated(PAGE.tab.id, { status: 'loading' });
  assert.deepEqual(clone((await env.ready()).counts), {});
});


test('failed live notification is reported as a warning after a successful policy commit', async () => {
  const env = setup();
  await env.ready();
  env.failures['tabs.query'] = [new Error('Cannot enumerate tabs')];
  const result = await env.settings({ lockScripts: true });
  assert.equal(result.ok, true);
  assert.match(result.warning, /Saved, but live page updates failed/);
  assert.equal(env.state.settings.lockScripts, true);
  assert.equal((await env.ready()).policyStatus.state, 'synced');
});
