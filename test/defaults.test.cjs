/* Fingerprint Damper - fresh-install defaults and manifest contract.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pins the shipped default profile (fresh install = reset-to-defaults =
 * documented README profile) and the manifest injection contract, so a
 * careless flip or manifest edit cannot change user-visible defaults
 * without a deliberate test change.
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const backgroundSrc = readFileSync(join(root, 'src/background.js'), 'utf8');
const lockdownSrc = readFileSync(join(root, 'src/lockdown.js'), 'utf8');

// Evaluate lockdown.js, then the DEFAULTS literal from background.js in the
// same context (DEFAULTS spreads FPDLockdown.defaults).
const ctx = vm.createContext({});
vm.runInContext(lockdownSrc, ctx);
const match = backgroundSrc.match(/const DEFAULTS = (\{[\s\S]*?\n\});/);
assert.ok(match, 'DEFAULTS literal must stay extractable');
// JSON round-trip brings the vm-realm object into this realm for deepEqual.
const DEFAULTS = JSON.parse(JSON.stringify(vm.runInContext('(' + match[1] + ')', ctx)));
const policy = ctx.FPDLockdown;

test('fresh-install defaults match the documented v1.2.x profile exactly', () => {
  assert.deepEqual(DEFAULTS, {
    canvas: true,
    webgl: true,
    audio: false,
    geometry: false,
    concurrency: true,
    battery: true,
    notify: false,
    swBlock: false,
    netBlock: false,
    clientRects: false,
    timezone: false,
    language: false,
    webrtc: false,
    speechVoices: false,
    mediaDevices: false,
    permissionStates: false,
    mathRounding: false,
    stats: false,
    ...Object.fromEntries(policy.keys.map(key => [key, false]))
  });
});

test('every experimental/behavior-altering protection is off by default', () => {
  const experimental = ['audio', 'geometry', 'notify', 'swBlock', 'netBlock', 'clientRects',
    'timezone', 'language', 'webrtc', 'speechVoices', 'mediaDevices',
    'permissionStates', 'mathRounding', 'stats'];
  for (const key of experimental) {
    assert.equal(DEFAULTS[key], false, `${key} must ship off`);
  }
  for (const key of policy.keys) {
    assert.equal(DEFAULTS[key], false, `lockdown ${key} must ship off`);
  }
});

test('quiet default profile: the page-visible stats channel is off', () => {
  assert.equal(DEFAULTS.stats, false);
  const injectSrc = readFileSync(join(root, 'src/inject.js'), 'utf8');
  assert.match(injectSrc, /stats: false/, 'inject.js cfg default must agree');
});

test('manifest identity and AMO-facing metadata are stable', () => {
  assert.equal(manifest.browser_specific_settings.gecko.id, 'fingerprint-damper@3spress0');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions,
    { required: ['none'] });
  assert.equal(manifest.declarative_net_request.rule_resources[0].enabled, false,
    'the static network ruleset must ship disabled');
});

test('manifest injection contract: MAIN world, document_start, all frames', () => {
  const [mainWorld, isolatedWorld] = manifest.content_scripts;
  assert.deepEqual(mainWorld.js, ['src/inject.js']);
  assert.equal(mainWorld.world, 'MAIN');
  assert.equal(mainWorld.run_at, 'document_start');
  assert.equal(mainWorld.all_frames, true);
  assert.equal(mainWorld.match_about_blank, true);
  assert.deepEqual(isolatedWorld.js, ['src/bridge.js']);
  assert.equal(isolatedWorld.world, 'ISOLATED');
  assert.equal(isolatedWorld.run_at, 'document_start');
  assert.equal(isolatedWorld.all_frames, true);
});

test('XPI filename, manifest version and git tag can agree (verify with --verify)', () => {
  // package.sh derives the artifact name from this exact field; pin the shape.
  assert.match(manifest.name, /^Fingerprint Damper$/);
});
