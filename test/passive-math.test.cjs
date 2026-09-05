/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const injection = new vm.Script(readFileSync(join(__dirname, '../src/inject.js'), 'utf8'));

function setup({ absent = false, mathStub = false } = {}) {
  const context = vm.createContext({});
  vm.runInContext(`
    globalThis.window = globalThis;
    globalThis.location = { origin: 'https://passive.example' };
    globalThis.timers = [];
    globalThis.events = [];
    globalThis.setTimeout = fn => { timers.push(fn); };
    class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    }
    class EventTarget {
      constructor() { this.listeners = new Map(); }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
      }
      removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
      dispatchEvent(event) {
        for (const fn of this.listeners.get(event.type) || []) fn.call(this, event);
        if (typeof this['on' + event.type] === 'function') this['on' + event.type](event);
        return true;
      }
    }
    class SpeechSynthesis extends EventTarget {
      constructor() {
        super(); this.voices = [{ name: 'Local Voice', lang: 'nl-NL', voiceURI: 'local:1' },
                               { name: 'Another Voice', lang: 'tr-TR', voiceURI: 'remote:2' }];
        this.spoken = [];
      }
      getVoices() {
        if (!(this instanceof SpeechSynthesis)) throw new TypeError('invalid SpeechSynthesis receiver');
        return this.voices;
      }
      speak(utterance) { this.spoken.push(utterance); }
    }
    class MediaDevices extends EventTarget {
      constructor() {
        super(); this.devices = [{ kind: 'audioinput', label: 'Studio Microphone', deviceId: 'mic', groupId: 'studio' },
          { kind: 'videoinput', label: 'Camera', deviceId: 'camera', groupId: 'studio' },
          { kind: 'audiooutput', label: 'Speakers', deviceId: 'speakers', groupId: 'output' }];
        this.captures = 0;
      }
      enumerateDevices() {
        if (!(this instanceof MediaDevices)) throw new TypeError('invalid MediaDevices receiver');
        return this.error ? Promise.reject(this.error) : this.pending || Promise.resolve(this.devices);
      }
      getUserMedia(constraints) { this.captures++; return Promise.resolve({ constraints }); }
      selectAudioOutput() { return Promise.resolve(this.devices[2]); }
    }
    class PermissionStatus extends EventTarget {
      constructor(name, state) { super(); this.name = name; this.actualState = state; }
      get state() {
        if (!(this instanceof PermissionStatus)) throw new TypeError('invalid PermissionStatus receiver');
        return this.actualState;
      }
    }
    class Permissions {
      constructor() {
        this.statuses = { geolocation: new PermissionStatus('geolocation', 'granted'),
          camera: new PermissionStatus('camera', 'denied'),
          notifications: new PermissionStatus('notifications', 'prompt') };
      }
      query(descriptor) {
        if (!(this instanceof Permissions)) throw new TypeError('invalid Permissions receiver');
        const name = descriptor.name;
        return this.statuses[name] ? Promise.resolve(this.statuses[name]) : Promise.reject(new TypeError('unsupported permission'));
      }
    }
    class Notification {
      static get permission() { return 'granted'; }
      static requestPermission(callback) {
        Notification.requests++;
        return Promise.resolve('granted').then(result => { if (callback) callback(result); return result; });
      }
    }
    Notification.requests = 0;
    Object.assign(globalThis, { CustomEvent, EventTarget, SpeechSynthesis, MediaDevices, PermissionStatus, Permissions, Notification });
    globalThis.document = new EventTarget();
    document.addEventListener('__fpd_stats', event => events.push(JSON.parse(event.detail)));
    globalThis.speechSynthesis = new SpeechSynthesis();
    globalThis.navigator = { mediaDevices: new MediaDevices(), permissions: new Permissions() };
    globalThis.native = {
      voices: SpeechSynthesis.prototype.getVoices, speak: SpeechSynthesis.prototype.speak,
      devices: MediaDevices.prototype.enumerateDevices, capture: MediaDevices.prototype.getUserMedia,
      query: Permissions.prototype.query,
      state: Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state'),
      notification: Object.getOwnPropertyDescriptor(Notification, 'permission'),
      request: Notification.requestPermission,
      math: Object.fromEntries(Object.getOwnPropertyNames(Math).map(name => [name, Math[name]]))
    };
    globalThis.floatFromBits = (hi, lo) => {
      const b = new DataView(new ArrayBuffer(8)); b.setUint32(0, hi); b.setUint32(4, lo); return b.getFloat64(0);
    };
    globalThis.floatBits = value => {
      const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, value); return [b.getUint32(0), b.getUint32(4)];
    };
  `, context);
  if (mathStub) vm.runInContext('Math.sin = function sin() { return globalThis.mathValue; };', context);
  if (absent) vm.runInContext(`
    delete globalThis.SpeechSynthesis; delete globalThis.speechSynthesis; delete globalThis.MediaDevices;
    delete globalThis.PermissionStatus; delete globalThis.Notification;
    delete navigator.mediaDevices; delete navigator.permissions;
  `, context);
  // Lexical class bindings can still exist, but the production guards use window.*.
  injection.runInContext(context);
  return {
    evaluate(code) { return vm.runInContext(code, context); },
    configure(message) {
      context.message = message;
      vm.runInContext("document.dispatchEvent(new CustomEvent('__fpd_config', { detail: JSON.stringify(message) }));", context);
    },
    stats() {
      vm.runInContext('for (const fn of timers.splice(0)) fn();', context);
      return JSON.parse(vm.runInContext('JSON.stringify(events.at(-1) || {})', context));
    }
  };
}

test('new passive and Math settings leave native results unchanged by default', async () => {
  const env = setup();
  assert.equal(await env.evaluate(`(async () =>
    speechSynthesis.getVoices() === speechSynthesis.voices &&
    await navigator.mediaDevices.enumerateDevices() === navigator.mediaDevices.devices &&
    (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted' &&
    Notification.permission === 'granted' && Math.sin(1) === native.math.sin(1) &&
    Math.sin === native.math.sin && navigator.permissions.query === native.query)()`), true);
  assert.deepEqual(env.stats(), {});
});

test('voice hiding returns a fresh empty list without replacing voices, speech or events', () => {
  const env = setup();
  env.configure({ settings: { speechVoices: true } });
  assert.equal(env.evaluate(`(() => {
    const first = speechSynthesis.getVoices();
    first.push('caller mutation');
    const second = speechSynthesis.getVoices();
    const utterance = { text: 'Native default speech', voice: null };
    speechSynthesis.speak(utterance);
    return Array.isArray(second) && second.length === 0 && native.voices.call(speechSynthesis).length === 2 &&
      speechSynthesis.speak === native.speak && speechSynthesis.spoken[0] === utterance;
  })()`), true);
  assert.throws(() => env.evaluate('SpeechSynthesis.prototype.getVoices.call({})'), /invalid SpeechSynthesis/);
  env.configure({ settings: { speechVoices: false } });
  assert.equal(env.evaluate('speechSynthesis.getVoices() === speechSynthesis.voices'), true);
});

test('device hiding conceals the entire list but leaves capture and native objects untouched', async () => {
  const env = setup();
  env.configure({ settings: { mediaDevices: true } });
  assert.equal(await env.evaluate(`(async () => {
    const promise = navigator.mediaDevices.enumerateDevices();
    const hidden = await promise;
    const raw = await native.devices.call(navigator.mediaDevices);
    const untouched = raw.length === 3 && raw[0].label === 'Studio Microphone' && raw[0].deviceId === 'mic';
    const noCapture = navigator.mediaDevices.captures === 0;
    const constraints = { audio: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return promise instanceof Promise && hidden.length === 0 && untouched && noCapture &&
      navigator.mediaDevices.getUserMedia === native.capture && stream.constraints === constraints;
  })()`), true);
  env.configure({ settings: { mediaDevices: false } });
  assert.equal(await env.evaluate('(async () => await navigator.mediaDevices.enumerateDevices() === navigator.mediaDevices.devices)()'), true);
});

test('device enumeration preserves native rejections and receiver errors', async () => {
  const env = setup();
  env.configure({ settings: { mediaDevices: true } });
  assert.throws(() => env.evaluate('MediaDevices.prototype.enumerateDevices.call({})'), /invalid MediaDevices/);
  assert.equal(await env.evaluate(`(async () => {
    navigator.mediaDevices.error = new Error('document is not fully active');
    try { await navigator.mediaDevices.enumerateDevices(); } catch (e) { return e === navigator.mediaDevices.error; }
    return false;
  })()`), true);
  assert.deepEqual(env.stats(), {});
});

for (const mode of ['enable', 'disable', 'allowlist']) {
  test(`in-flight device reads honor ${mode} at fulfillment`, async () => {
    const env = setup();
    if (mode !== 'enable') env.configure({ settings: { mediaDevices: true } });
    env.evaluate(`navigator.mediaDevices.pending = new Promise(resolve => globalThis.finish = resolve);
      globalThis.pending = navigator.mediaDevices.enumerateDevices();`);
    env.configure(mode === 'allowlist' ? { allowlisted: true } : { settings: { mediaDevices: mode === 'enable' } });
    env.evaluate('finish(navigator.mediaDevices.devices);');
    assert.equal(await env.evaluate('pending.then(devices => devices.length)'), mode === 'enable' ? 0 : 3);
  });
}

test('permission masking retains native queries and status objects without changing grants', async () => {
  const env = setup();
  env.configure({ settings: { permissionStates: true } });
  assert.equal(await env.evaluate(`(async () => {
    let nameReads = 0;
    const granted = await navigator.permissions.query({ get name() { nameReads++; return 'geolocation'; } });
    const denied = await navigator.permissions.query({ name: 'camera' });
    return granted instanceof PermissionStatus && granted === navigator.permissions.statuses.geolocation &&
      granted.state === 'prompt' && denied.state === 'prompt' && Notification.permission === 'default' &&
      native.state.get.call(granted) === 'granted' && native.state.get.call(denied) === 'denied' &&
      native.notification.get.call(Notification) === 'granted' && Notification.requests === 0 &&
      nameReads === 1 && Permissions.prototype.query === native.query;
  })()`), true);
  assert.throws(() => env.evaluate("Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state').get.call({})"), /invalid PermissionStatus/);
  assert.equal(await env.evaluate(`(async () => {
    try { await navigator.permissions.query({ name: 'not-supported' }); } catch (e) { return e instanceof TypeError; }
    return false;
  })()`), true);
  env.configure({ settings: { permissionStates: false } });
  assert.equal(env.evaluate("navigator.permissions.statuses.geolocation.state === 'granted' && Notification.permission === 'granted'"), true);
});

test('permission change events and listener removal stay native while their state reads are masked', () => {
  const env = setup();
  env.configure({ settings: { permissionStates: true } });
  assert.equal(env.evaluate(`(() => {
    const status = navigator.permissions.statuses.geolocation;
    const seen = [];
    const listener = function () { seen.push(this.state); };
    status.addEventListener('change', listener);
    status.onchange = () => seen.push(status.state);
    status.actualState = 'denied';
    status.dispatchEvent({ type: 'change' });
    status.removeEventListener('change', listener);
    status.onchange = null;
    status.dispatchEvent({ type: 'change' });
    return seen.join(',') === 'prompt,prompt' && native.state.get.call(status) === 'denied';
  })()`), true);
});

test('notification requests obey pushGuard independently of passive permission masking', async () => {
  const env = setup();
  assert.equal(await env.evaluate("Notification.requestPermission().then(value => value === 'default' && Notification.requests === 0)"), true);
  env.configure({ settings: { pushGuard: false, permissionStates: true } });
  assert.equal(await env.evaluate(`(async () => {
    let callbackValue;
    const result = await Notification.requestPermission(value => { callbackValue = value; });
    return result === 'granted' && callbackValue === 'granted' && Notification.requests === 1 &&
      Notification.permission === 'default';
  })()`), true);
});

test('Math rounding is stable and bounded across all covered functions', () => {
  const env = setup();
  env.configure({ settings: { mathRounding: true } });
  assert.equal(env.evaluate(`(() => {
    const inputs = {
      acos: [.123], acosh: [1.2345], asin: [.123], asinh: [.123], atan: [.123], atanh: [.123], atan2: [.123, .456],
      cos: [123.456], cosh: [.123], exp: [.123], expm1: [.123], log: [.123], log1p: [.123], log2: [.123], log10: [.123],
      sin: [123.456], sinh: [.123], tan: [.123], tanh: [.123], pow: [Math.PI, -100], sqrt: [2], cbrt: [2], hypot: [.123, .456]
    };
    let changed = 0;
    for (const [name, args] of Object.entries(inputs)) {
      const raw = native.math[name](...args);
      const actual = Math[name](...args);
      if (raw !== actual) changed++;
      if (Math.abs(actual - raw) / Math.abs(raw) > 2 ** -41 || actual !== Math[name](...args)) return false;
    }
    return changed >= 20 && Math.random === native.math.random && Math.floor === native.math.floor &&
      Math.imul === native.math.imul && Math.fround === native.math.fround && Math.PI === native.math.PI;
  })()`), true);
  const first = env.evaluate('Math.sin(1)');
  env.configure({ salt: 'different-salt' });
  assert.equal(env.evaluate('Math.sin(1)'), first, 'rounding is uniform, not origin/session jitter');
  for (let i = 0; i < 3; i++) {
    env.configure({ settings: { mathRounding: false } });
    assert.equal(env.evaluate('Math.sin === native.math.sin && Math.sin(1) === native.math.sin(1)'), true);
    env.configure({ settings: { mathRounding: true } });
    assert.equal(env.evaluate('Math.sin(1)'), first);
  }
});

test('Math rounding preserves NaN, infinities, signed zero, integers and subnormal results', () => {
  const env = setup();
  env.configure({ settings: { mathRounding: true } });
  assert.equal(env.evaluate(`[
    ['sin', [-0]], ['sqrt', [-0]], ['atan2', [-0, 1]], ['pow', [-0, 3]], ['hypot', []],
    ['sin', [Infinity]], ['sqrt', [-1]], ['log', [0]], ['log', [-0]], ['exp', [Infinity]],
    ['exp', [-Infinity]], ['exp', [0]], ['cos', [0]], ['pow', [2, 40]],
    ['expm1', [Number.MIN_VALUE]], ['log1p', [Number.MIN_VALUE]], ['exp', [-744]]
  ].every(([name, args]) => Object.is(Math[name](...args), native.math[name](...args)))`), true);
});

test('Math bit rounding uses nearest-even ties and carries across mantissa words', () => {
  const env = setup({ mathStub: true });
  env.configure({ settings: { mathRounding: true } });
  const cases = [
    [0x3ff00000, 0x12344800, 0x3ff00000, 0x12344000],
    [0x3ff00000, 0x12345800, 0x3ff00000, 0x12346000],
    [0x3ff00000, 0x12345001, 0x3ff00000, 0x12345000],
    [0x3ff00000, 0x12345fff, 0x3ff00000, 0x12346000],
    [0x3fefffff, 0xfffffff1, 0x3ff00000, 0],
    [0xbff00000, 0x12345fff, 0xbff00000, 0x12346000],
    [0x00000000, 0x00000801, 0x00000000, 0x00000801]
  ];
  for (const [hi, lo, expectedHi, expectedLo] of cases) {
    const actual = env.evaluate(`mathValue = floatFromBits(${hi}, ${lo}); floatBits(Math.sin(1));`);
    assert.deepEqual(Array.from(actual), [expectedHi, expectedLo]);
  }
});

test('Math methods preserve coercion, exceptions, metadata and non-constructibility', () => {
  const env = setup();
  for (const enabled of [false, true]) {
    env.configure({ settings: { mathRounding: enabled } });
    assert.equal(env.evaluate(`(() => {
      let reads = 0;
      Math.sin({ [Symbol.toPrimitive](hint) { if (hint !== 'number') throw new Error('wrong hint'); reads++; return 1; } });
      let secondRead = 0;
      Math.hypot(Infinity, { valueOf() { secondRead++; return NaN; } });
      const throwsType = fn => { try { fn(); } catch (e) { return e instanceof TypeError; } return false; };
      return reads === 1 && secondRead === 1 && throwsType(() => Math.sin(Symbol())) &&
        throwsType(() => Math.sin(1n)) && throwsType(() => new Math.sin(1)) &&
        Math.sin.name === 'sin' && Math.atan2.length === 2 &&
        !Object.prototype.hasOwnProperty.call(Math.sin, 'prototype');
    })()`), true);
  }
  env.configure({ settings: { mathRounding: false } });
  env.evaluate('globalThis.customSin = function customSin(value) { return native.math.sin(value); }; Math.sin = customSin;');
  env.configure({ settings: { mathRounding: true } });
  assert.equal(env.evaluate('customSin.name === "customSin" && Math.sin.name === "customSin"'), true);
  env.configure({ settings: { mathRounding: false } });
  assert.equal(env.evaluate('Math.sin === customSin && customSin.name === "customSin"'), true);
});

test('optional passive APIs can be absent without preventing Math or other patches', () => {
  const env = setup({ absent: true });
  env.configure({ settings: { speechVoices: true, mediaDevices: true, permissionStates: true, mathRounding: true } });
  assert.equal(env.evaluate('Math.sin(1) !== native.math.sin(1)'), true);
});

test('new activity counts contain counts only and respect the stats setting', async () => {
  const env = setup();
  env.configure({ settings: { speechVoices: true, mediaDevices: true, permissionStates: true, mathRounding: true } });
  await env.evaluate(`(async () => {
    speechSynthesis.getVoices(); await navigator.mediaDevices.enumerateDevices();
    void navigator.permissions.statuses.geolocation.state; void Notification.permission; Math.sin(1);
  })()`);
  assert.deepEqual(env.stats(), { speechVoices: 1, mediaDevices: 1, permissionStates: 2, mathRounding: 1 });
  env.configure({ settings: { stats: false } });
  env.evaluate('speechSynthesis.getVoices(); Math.sin(1);');
  assert.deepEqual(env.stats(), { speechVoices: 1, mediaDevices: 1, permissionStates: 2, mathRounding: 1 });
});

test('allowlisting restores all new methods, descriptors and native Math behavior', async () => {
  const env = setup();
  env.configure({ settings: { speechVoices: true, mediaDevices: true, permissionStates: true, mathRounding: true } });
  env.evaluate('globalThis.savedSin = Math.sin;');
  env.configure({ allowlisted: true });
  assert.equal(await env.evaluate(`(async () =>
    SpeechSynthesis.prototype.getVoices === native.voices && MediaDevices.prototype.enumerateDevices === native.devices &&
    Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state').get === native.state.get &&
    Object.getOwnPropertyDescriptor(Notification, 'permission').get === native.notification.get &&
    Notification.requestPermission === native.request && Math.sin === native.math.sin &&
    savedSin(1) === native.math.sin(1) && (await navigator.mediaDevices.enumerateDevices()).length === 3
  )()`), true);
  env.configure({ allowlisted: false });
  assert.equal(env.evaluate('Math.sin === native.math.sin && savedSin(1) === native.math.sin(1)'), true,
    'after full restoration, reload is required to install hooks again');
});
