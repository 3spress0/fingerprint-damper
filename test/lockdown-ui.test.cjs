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
const copy = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.disabled = false;
    const classes = new Set();
    this.classList = { add: key => classes.add(key), remove: key => classes.delete(key),
      contains: key => classes.has(key), toggle: (key, on) => on ? classes.add(key) : classes.delete(key) };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || ''; }
  append(...values) { this.children.push(...values); }
  appendChild(value) { this.append(value); }
  addEventListener(type, fn) { this.events[type] = fn; }
  async fire(type = 'click') { if (!this.disabled) await this.events[type]?.({ preventDefault() {} }); }
}
function ui(page, initial = {}) {
  const ids = ['safe', 'risky', 'lockdown', 'lock-max', 'lock-off', 'policy-status', 'save-error', 'saved',
    'origin', 'counts', 'allow', 'opts', 'action-error'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element(['lock-max', 'lock-off', 'allow'].includes(id) ? 'button' : 'div')]));
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const document = { getElementById: id => nodes[id], createElement: tag => new Element(tag),
    querySelectorAll: () => Object.values(nodes).flatMap(flatten).filter(node => ['input', 'button'].includes(node.tag)) };
  const state = { data: { settings: {}, counts: {}, origin: 'https://site.test', allowlisted: false,
    policyStatus: { state: 'synced', ruleCount: 0 }, ...initial }, confirm: false, messages: [], reloads: 0, closed: false, failure: null };
  const browser = { runtime: {
    async sendMessage(msg) {
      state.messages.push(copy(msg));
      if (msg.type === 'popupData') {
        if (state.failReadOnce) { state.failReadOnce = false; throw new Error('Read failed'); }
        return copy(state.data);
      }
      if (state.failure) return { ok: false, error: state.failure };
      if (msg.type === 'setSettings') Object.assign(state.data.settings, msg.settings);
      if (msg.type === 'disableLockdown') {
        for (const key of context.FPDLockdown.keys) state.data.settings[key] = false;
        if (state.afterDisable) state.afterDisable();
      }
      if (msg.type === 'toggleAllowlist') state.data.allowlisted = !state.data.allowlisted;
      return { ok: true };
    }, openOptionsPage() {} }, tabs: { async query() { return [{ id: 1 }]; }, async reload() { state.reloads++; } } };
  const context = vm.createContext({ browser, document, setTimeout: () => 1, clearTimeout() {},
    window: { confirm: () => state.confirm, close: () => { state.closed = true; } } });
  vm.runInContext(core, context);
  vm.runInContext(readFileSync(join(__dirname, '../src/' + page + '.js'), 'utf8'), context);
  return { state, nodes, keys: context.FPDLockdown.keys,
    controls: () => document.querySelectorAll().filter(node => node.tag === 'input'),
    ready: () => new Promise(setImmediate) };
}

test('options render every lockdown control off without making an opt-in write', async () => {
  const env = ui('options');
  await env.ready();
  for (const key of env.keys) {
    const control = env.controls().find(node => node.dataset.key === key);
    assert.ok(control);
    assert.equal(control.checked, false);
  }
  assert.ok(env.state.messages.every(msg => msg.type === 'popupData'));
});

test('maximum lockdown requires confirmation and changes only lockdown settings', async () => {
  const env = ui('options', { settings: { canvas: false, mathRounding: true } });
  await env.ready();
  await env.nodes['lock-max'].fire();
  assert.ok(env.state.messages.every(msg => msg.type === 'popupData'));
  env.state.confirm = true;
  await env.nodes['lock-max'].fire();
  assert.ok(env.keys.every(key => env.state.data.settings[key] === true));
  assert.equal(env.state.data.settings.canvas, false);
  assert.equal(env.state.data.settings.mathRounding, true);
  assert.equal(env.state.reloads, 0);
  await env.nodes['lock-off'].fire();
  assert.ok(env.keys.every(key => env.state.data.settings[key] === false));
  assert.equal(env.state.data.settings.mathRounding, true);
});

test('failed option saves revert the checkbox, show the error and never show Saved', async () => {
  const env = ui('options');
  await env.ready();
  const cb = env.controls().find(node => node.dataset.key === 'lockSandbox');
  env.state.failure = 'DNR rejected the policy';
  cb.checked = true;
  await cb.fire('change');
  assert.equal(env.controls().find(node => node.dataset.key === 'lockSandbox').checked, false);
  assert.match(env.nodes['save-error'].textContent, /Not saved.*DNR rejected/);
  assert.equal(env.nodes.saved.classList.contains('show'), false);
  assert.equal(env.nodes['lock-off'].disabled, false);
});

test('popup keeps global lockdown distinct from per-site API pause', async () => {
  const env = ui('popup', { settings: { lockSandbox: true }, allowlisted: true,
    policyStatus: { state: 'synced', ruleCount: 2 } });
  await env.ready();
  assert.match(env.nodes.allow.textContent, /Resume API patches/);
  assert.match(env.nodes['policy-status'].textContent, /globally.*2 rules configured/);
  assert.match(env.nodes.counts.children[0].textContent, /API patches paused/);
});

test('popup emergency off works without a site origin and does not auto-reload tabs', async () => {
  const env = ui('popup', { origin: null, settings: { lockResources: true } });
  await env.ready();
  assert.equal(env.nodes.allow.disabled, true);
  await env.nodes['lock-off'].fire();
  assert.ok(env.state.messages.some(msg => msg.type === 'disableLockdown'));
  assert.match(env.nodes['policy-status'].textContent, /off for future loads.*Reload/);
  assert.equal(env.state.reloads, 0);
  assert.equal(env.state.closed, false);
});

test('popup removal failures remain visible instead of claiming lockdown is off', async () => {
  const env = ui('popup', { settings: { lockScripts: true },
    policyStatus: { state: 'error', error: 'Previous rollback failed', ruleCount: null } });
  await env.ready();
  env.state.failure = 'Cannot remove rules';
  await env.nodes['lock-off'].fire();
  assert.match(env.nodes['action-error'].textContent, /Cannot remove/);
  assert.match(env.nodes['policy-status'].textContent, /Policy error/);
  assert.equal(env.nodes['lock-off'].disabled, false);
  assert.equal(env.state.data.settings.lockScripts, true);
});


test('post-save UI read failure is not misrepresented as a failed setting change', async () => {
  const env = ui('options');
  await env.ready();
  env.state.failReadOnce = true;
  const cb = env.controls().find(node => node.dataset.key === 'lockScripts');
  cb.checked = true;
  await cb.fire('change');
  assert.equal(env.state.data.settings.lockScripts, true);
  assert.match(env.nodes['save-error'].textContent, /Saved, but UI refresh failed/);
});

test('popup does not overwrite newer global state with a stale off confirmation', async () => {
  const env = ui('popup', { settings: { lockScripts: true }, policyStatus: { state: 'synced', ruleCount: 2 } });
  await env.ready();
  env.state.afterDisable = () => { env.state.data.settings.lockScripts = true; };
  await env.nodes['lock-off'].fire();
  assert.match(env.nodes['policy-status'].textContent, /controls selected globally/);
  assert.doesNotMatch(env.nodes['policy-status'].textContent, /off for future/);
});
