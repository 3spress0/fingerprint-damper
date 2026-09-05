/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, 'font-probes.js'), 'utf8');

test('font diagnostics distinguish check() from local-font availability without registering faces', async () => {
  const calls = [];
  class FontFace {
    constructor(family, source) { this.family = family; this.source = source; calls.push(source); }
    load() {
      return this.source === 'local("DejaVu Sans")'
        ? Promise.resolve(this) : Promise.reject(new Error('absent or blocked'));
    }
  }
  const fonts = {
    check() { return true; },
    add() { throw new Error('diagnostic must not add document faces'); },
    *[Symbol.iterator]() { yield { family: 'Document Web Font' }; }
  };
  const context = vm.createContext({ window: { FontFace }, FontFace, document: { fonts } });
  vm.runInContext(source, context);
  const result = await vm.runInContext('probeLocalFonts()', context);
  assert.equal(result.supported, true);
  assert.equal(result.missingCheck, true);
  assert.equal(result.missingLoaded, false);
  assert.deepEqual(Array.from(result.availableCandidates), ['DejaVu Sans']);
  assert.deepEqual(Array.from(result.documentFamilies), ['Document Web Font']);
  assert.equal(calls.length, 7);
  assert.ok(calls.every(call => call.startsWith('local(')), 'no remote font URLs');
});

test('font diagnostics tolerate browsers without the FontFace API', async () => {
  const context = vm.createContext({ window: {}, document: {} });
  vm.runInContext(source, context);
  const result = await vm.runInContext('probeLocalFonts()', context);
  assert.equal(result.supported, false);
});
