/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Dependency-free regression tests for the page-world patches. The DOM doubles
// live in a fresh VM context per test; no browser or test runner install needed.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const script = new vm.Script(readFileSync(join(__dirname, '../src/inject.js'), 'utf8'));
const METRICS = {
  width: 123.25,
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: 122,
  actualBoundingBoxAscent: 12,
  actualBoundingBoxDescent: 3,
  fontBoundingBoxAscent: 15,
  fontBoundingBoxDescent: 4
};

function setup({ origin = 'https://one.example', day = '2026-09-05', offscreen = true,
                 prototypeGeometry = false } = {}) {
  const timers = [];
  const events = [];
  const listeners = new Map();
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  class TextMetrics {}
  for (const [name, value] of Object.entries({ ...METRICS, alphabeticBaseline: 0 })) {
    Object.defineProperty(TextMetrics.prototype, name, {
      configurable: true, enumerable: true, get() { return value; }
    });
  }

  function contextClass() {
    return class {
      constructor(canvas) { this.canvas = canvas; this.font = '16px Arial'; }
      measureText(text) {
        if (!arguments.length) throw new TypeError('missing text');
        String(text);
        return new TextMetrics();
      }
      getImageData() {
        if (this.canvas.readError) throw this.canvas.readError;
        this.lastReadArgs = Array.from(arguments);
        return { data: this.canvas.pixels.slice() };
      }
      drawImage(canvas) {
        this.canvas.pixels = canvas.pixels.slice();
        this.canvas.readError = canvas.readError;
      }
      putImageData(data) { this.canvas.pixels = data.data.slice(); }
    };
  }
  const CanvasRenderingContext2D = contextClass();
  const OffscreenCanvasRenderingContext2D = contextClass();
  function canvasClass(Context) {
    return class {
      constructor(width = 60, height = 20) {
        this.width = width;
        this.height = height;
        this.pixels = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < this.pixels.length; i += 4) {
          this.pixels.set([18, 52, 86, 255], i);
        }
      }
      getContext(type) {
        if (type !== '2d') return null;
        return this.context || (this.context = new Context(this));
      }
      toDataURL() { return { data: this.pixels.slice() }; }
      convertToBlob(options) {
        if (this.readError) return Promise.reject(this.readError);
        if (!this.width || !this.height) return Promise.reject(new Error('empty canvas'));
        return Promise.resolve({ data: this.pixels.slice(), canvas: this, options });
      }
    };
  }
  const HTMLCanvasElement = canvasClass(CanvasRenderingContext2D);
  const OffscreenCanvas = canvasClass(OffscreenCanvasRenderingContext2D);

  class DOMRect {
    constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height }); }
    get left() { return Math.min(this.x, this.x + this.width); }
    get right() { return Math.max(this.x, this.x + this.width); }
    get top() { return Math.min(this.y, this.y + this.height); }
    get bottom() { return Math.max(this.y, this.y + this.height); }
    toJSON() {
      return Object.fromEntries(['x', 'y', 'width', 'height', 'left', 'right', 'top', 'bottom'].map((k) => [k, this[k]]));
    }
  }
  class DOMRectList {
    constructor(rects) { rects.forEach((rect, i) => { this[i] = rect; }); this.length = rects.length; }
    item(index) { return this[Number(index) >>> 0] || null; }
    *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) yield this[i]; }
  }
  function elementClass() {
    return class {
      constructor(boxes = [[10.25, 20.5, 70.75, 18.25]]) { this.boxes = boxes; }
      getClientRects() {
        if (!this || !this.boxes) throw new TypeError('illegal receiver');
        return new DOMRectList(this.boxes.map((r) => new DOMRect(...r)));
      }
      getBoundingClientRect() {
        if (!this || !this.boxes) throw new TypeError('illegal receiver');
        const nonempty = this.boxes.filter((r) => r[2] && r[3]);
        if (!nonempty.length) return new DOMRect(...(this.boxes[0] || []));
        const x = Math.min(...nonempty.map((r) => r[0]));
        const y = Math.min(...nonempty.map((r) => r[1]));
        const right = Math.max(...nonempty.map((r) => r[0] + r[2]));
        const bottom = Math.max(...nonempty.map((r) => r[1] + r[3]));
        return new DOMRect(x, y, right - x, bottom - y);
      }
    };
  }
  const Element = elementClass();
  const Range = elementClass();

  class Screen {
    constructor() {
      this.width = 1920;
      this.height = 1080;
      this.real = { availWidth: 1880, availHeight: 1040, availLeft: 40, availTop: 24,
                    colorDepth: 30, pixelDepth: 30 };
    }
  }
  for (const name of Object.keys(new Screen().real)) {
    Object.defineProperty(Screen.prototype, name, {
      configurable: true, enumerable: true, get() { return this.real[name]; }
    });
  }
  function glClass(version) {
    return class {
      getParameter(p) { return p === 0x1f02 ? version + ' native' : 'native:' + p; }
    };
  }
  const sandbox = {
    CustomEvent, Screen, TextMetrics, HTMLCanvasElement, CanvasRenderingContext2D,
    DOMRect, DOMRectList, Element, Range,
    WebGLRenderingContext: glClass('WebGL 1.0'),
    WebGL2RenderingContext: glClass('WebGL 2.0'),
    location: { origin },
    screen: new Screen(),
    innerWidth: 1000, innerHeight: 700,
    positions: { screenX: 143, screenY: 87, screenLeft: 143, screenTop: 87,
                 outerWidth: 1200, outerHeight: 900 },
    setTimeout(callback) { timers.push(callback); },
    document: {
      createElement(name) {
        assert.equal(name, 'canvas');
        return new HTMLCanvasElement();
      },
      addEventListener(type, listener) { listeners.set(type, listener); },
      dispatchEvent(event) {
        events.push(event);
        if (listeners.has(event.type)) listeners.get(event.type)(event);
        return true;
      }
    }
  };
  if (offscreen) Object.assign(sandbox, { OffscreenCanvas, OffscreenCanvasRenderingContext2D });
  // A separate Window double avoids Node's special VM global proxy, which
  // hides the sandbox's prototype from Object.getPrototypeOf inside the VM.
  const pageWindow = { ...sandbox };
  const host = prototypeGeometry ? {} : pageWindow;
  if (prototypeGeometry) Object.setPrototypeOf(pageWindow, host);
  for (const name of Object.keys(sandbox.positions)) {
    Object.defineProperty(host, name, {
      configurable: true, enumerable: true, get() { return this.positions[name]; }
    });
  }
  sandbox.window = pageWindow;
  const context = vm.createContext(sandbox);
  // Keep daily seed rotation deterministic without patching the test runner's Date.
  vm.runInContext(`Date = new Proxy(Date, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : ['${day}T12:00:00Z'], newTarget);
    }
  });
  Object.assign(window, { Intl, Date, Number, BigInt, String, Math, DataView, ArrayBuffer });
  globalThis.nativeIntl = Object.fromEntries(Object.getOwnPropertyNames(Intl).map(k => [k, Intl[k]]));
  globalThis.nativeLocaleMethods = {
    number: Number.prototype.toLocaleString, date: Date.prototype.toLocaleString,
    dateOnly: Date.prototype.toLocaleDateString, timeOnly: Date.prototype.toLocaleTimeString,
    compare: String.prototype.localeCompare, upper: String.prototype.toLocaleUpperCase,
    offset: Date.prototype.getTimezoneOffset
  };`, context);
  const originals = {
    measureText: CanvasRenderingContext2D.prototype.measureText,
    offscreenMeasureText: OffscreenCanvasRenderingContext2D.prototype.measureText,
    getImageData: OffscreenCanvasRenderingContext2D.prototype.getImageData,
    convertToBlob: OffscreenCanvas.prototype.convertToBlob,
    availWidth: Object.getOwnPropertyDescriptor(Screen.prototype, 'availWidth').get,
    screenX: Object.getOwnPropertyDescriptor(host, 'screenX').get,
    elementBounds: Element.prototype.getBoundingClientRect,
    elementRects: Element.prototype.getClientRects,
    rangeBounds: Range.prototype.getBoundingClientRect,
    rangeRects: Range.prototype.getClientRects
  };
  script.runInContext(context);
  const configure = (message) => sandbox.document.dispatchEvent(new CustomEvent('__fpd_config', {
    detail: JSON.stringify(message)
  }));
  configure({ salt: 'test-session' });
  return {
    ...sandbox, host, originals, configure,
    evaluate(code) { return vm.runInContext(code, context); },
    flushStats() {
      for (const callback of timers.splice(0)) callback();
      const event = events.filter((ev) => ev.type === '__fpd_stats').pop();
      return event ? JSON.parse(event.detail) : {};
    }
  };
}

function assertNoise(actual, original) {
  let changed = 0;
  assert.equal(actual.length, original.length);
  for (let i = 0; i < actual.length; i++) {
    if (i % 4 === 3) assert.equal(actual[i], original[i], 'alpha stays unchanged');
    if (actual[i] !== original[i]) {
      changed++;
      assert.equal(Math.abs(actual[i] - original[i]), 1);
    }
  }
  assert.ok(changed > 0 && changed <= 32 * 3, `one noise pass, not ${changed} changed channels`);
}

for (const ctor of ['HTMLCanvasElement', 'OffscreenCanvas']) {
  test(`${ctor} text metrics are stable, bounded, and toggleable`, () => {
    const env = setup();
    const ctx = new env[ctor]().getContext('2d');
    const first = ctx.measureText('The quick brown fox 0123456789');
    const second = ctx.measureText('The quick brown fox 0123456789');
    assert.ok(first instanceof env.TextMetrics);
    for (const [name, value] of Object.entries(METRICS)) {
      assert.notEqual(first[name], value);
      assert.ok(Math.abs(first[name] - value) < 0.01);
      assert.equal(first[name], second[name]);
    }
    assert.equal(first.alphabeticBaseline, 0);
    assert.equal(ctx.font, '16px Arial');
    assert.notEqual(ctx.measureText('different text').width, first.width);
    ctx.font = '16px serif';
    assert.notEqual(ctx.measureText('The quick brown fox 0123456789').width, first.width);
    ctx.font = '16px Arial';
    env.configure({ settings: { canvas: false } });
    const real = ctx.measureText('The quick brown fox 0123456789');
    for (const [name, value] of Object.entries(METRICS)) assert.equal(real[name], value);
    env.configure({ settings: { canvas: true } });
    assert.equal(ctx.measureText('The quick brown fox 0123456789').width, first.width);
    assert.throws(() => ctx.measureText(), /missing text/);
    const error = new Error('text conversion failed');
    assert.throws(() => ctx.measureText({ toString() { throw error; } }), (e) => e === error);
  });
}

test('text jitter is consistent across canvas types and rotates with origin, day, and salt', () => {
  const width = (env, ctor = 'HTMLCanvasElement') => new env[ctor]().getContext('2d').measureText('probe').width;
  const env = setup();
  const baseline = width(env);
  assert.equal(width(env, 'OffscreenCanvas'), baseline);
  assert.equal(width(setup()), baseline);
  assert.notEqual(width(setup({ origin: 'https://two.example' })), baseline);
  assert.notEqual(width(setup({ day: '2026-09-06' })), baseline);
  env.configure({ salt: 'another-session' });
  assert.notEqual(width(env), baseline);
});

test('unsupported optional text metric fields are left absent', () => {
  const env = setup();
  delete env.TextMetrics.prototype.fontBoundingBoxAscent;
  delete env.TextMetrics.prototype.fontBoundingBoxDescent;
  const m = new env.OffscreenCanvas().getContext('2d').measureText('probe');
  assert.notEqual(m.width, METRICS.width);
  assert.equal('fontBoundingBoxAscent' in m, false);
  assert.equal('fontBoundingBoxDescent' in m, false);
});

test('OffscreenCanvas pixel reads use stable noise without changing the live canvas', () => {
  const env = setup();
  const canvas = new env.OffscreenCanvas();
  const ctx = canvas.getContext('2d');
  const original = canvas.pixels.slice();
  const options = { colorSpace: 'srgb' };
  const first = ctx.getImageData(0, 0, 60, 20, options).data;
  assertNoise(first, original);
  assert.deepEqual(ctx.lastReadArgs, [0, 0, 60, 20, options]);
  assert.deepEqual(ctx.getImageData(0, 0, 60, 20).data, first);
  assert.deepEqual(new env.HTMLCanvasElement().getContext('2d').getImageData(0, 0, 60, 20).data, first);
  assert.deepEqual(canvas.pixels, original);
  env.configure({ settings: { canvas: false } });
  assert.deepEqual(ctx.getImageData(0, 0, 60, 20).data, original);
  env.configure({ settings: { canvas: true } });
  assert.deepEqual(ctx.getImageData(0, 0, 60, 20).data, first);
  canvas.readError = new Error('tainted canvas');
  assert.throws(() => ctx.getImageData(0, 0, 60, 20), (e) => e === canvas.readError);
});

test('convertToBlob noises a copy exactly once and forwards encoding options', async () => {
  const env = setup();
  const canvas = new env.OffscreenCanvas();
  const original = canvas.pixels.slice();
  const options = { type: 'image/webp', quality: 0.8 };
  const blob = await canvas.convertToBlob(options);
  assertNoise(blob.data, original);
  assert.equal(env.flushStats().canvas, 1, 'the internal readback must not report again');
  assert.equal(blob.options, options);
  assert.notEqual(blob.canvas, canvas);
  assert.deepEqual(canvas.pixels, original);
  assert.deepEqual((await canvas.convertToBlob(options)).data, blob.data);
  // Both serializers use baseSeed alone. A patched internal getImageData would
  // apply a second, dimension-seeded pass and violate this equality and budget.
  assert.deepEqual(new env.HTMLCanvasElement().toDataURL().data, blob.data);
  env.configure({ settings: { canvas: false } });
  const real = await canvas.convertToBlob(options);
  assert.equal(real.canvas, canvas);
  assert.deepEqual(real.data, original);
});

test('convertToBlob preserves native errors and falls back when a copy cannot be made', async () => {
  const env = setup();
  await assert.rejects(new env.OffscreenCanvas(0, 20).convertToBlob(), /empty canvas/);
  const tainted = new env.OffscreenCanvas();
  tainted.readError = new Error('tainted canvas');
  await assert.rejects(tainted.convertToBlob(), (e) => e === tainted.readError);
  env.OffscreenCanvas.prototype.getContext = () => null;
  const canvas = new env.OffscreenCanvas();
  const result = await canvas.convertToBlob();
  assert.equal(result.canvas, canvas);
  assert.deepEqual(result.data, canvas.pixels);
});

test('convertToBlob skips canvases over four megapixels', async () => {
  const env = setup();
  const canvas = new env.OffscreenCanvas(2001, 2000);
  const result = await canvas.convertToBlob();
  assert.equal(result.canvas, canvas);
  assert.deepEqual(result.data, canvas.pixels);
  assert.equal(env.flushStats().canvas, undefined);
});

for (const prototypeGeometry of [false, true]) {
  test(`geometry restores native values when off (window ${prototypeGeometry ? 'prototype' : 'instance'})`, () => {
    const env = setup({ prototypeGeometry });
    const protectedValues = { availWidth: 1920, availHeight: 1080, availLeft: 0,
                              availTop: 0, colorDepth: 24, pixelDepth: 24 };
    const screenValues = () => Object.fromEntries(Object.keys(env.screen.real).map((p) => [p, env.screen[p]]));
    assert.deepEqual(screenValues(), protectedValues);
    assert.equal(env.window.screenX, 0);
    assert.equal(env.window.outerWidth, env.innerWidth);
    env.configure({ settings: { geometry: false } });
    assert.deepEqual(screenValues(), env.screen.real);
    for (const [p, value] of Object.entries(env.positions)) assert.equal(env.window[p], value);
    env.screen.real.availWidth = 1800;
    env.positions.screenX = 231;
    assert.equal(env.screen.availWidth, 1800);
    assert.equal(env.window.screenX, 231);
    env.configure({ settings: { geometry: true } });
    assert.deepEqual(screenValues(), protectedValues);
    for (const p of ['screenX', 'screenY', 'screenLeft', 'screenTop']) assert.equal(env.window[p], 0);
    assert.equal(env.screen.width, 1920);
    assert.equal(env.screen.height, 1080);
  });
}

test('WebGL versions match the context class and disabling masking restores native values', () => {
  const env = setup();
  const gl1 = new env.WebGLRenderingContext();
  const gl2 = new env.WebGL2RenderingContext();
  assert.equal(gl1.getParameter(0x1f02), 'WebGL 1.0');
  assert.equal(gl2.getParameter(0x1f02), 'WebGL 2.0');
  for (const gl of [gl1, gl2]) {
    for (const p of [0x9245, 0x9246, 0x1f00, 0x1f01]) assert.equal(gl.getParameter(p), 'Mozilla');
    assert.equal(gl.getParameter(0x0d33), 'native:3379');
  }
  env.configure({ settings: { webgl: false } });
  assert.equal(gl1.getParameter(0x1f02), 'WebGL 1.0 native');
  assert.equal(gl2.getParameter(0x1f02), 'WebGL 2.0 native');
});

test('allowlisting restores the original canvas methods and geometry descriptors', async () => {
  const env = setup();
  const canvas = new env.OffscreenCanvas();
  const ctx = canvas.getContext('2d');
  env.configure({ allowlisted: true });
  assert.equal(env.CanvasRenderingContext2D.prototype.measureText, env.originals.measureText);
  assert.equal(ctx.measureText, env.originals.offscreenMeasureText);
  assert.equal(ctx.getImageData, env.originals.getImageData);
  assert.equal(canvas.convertToBlob, env.originals.convertToBlob);
  assert.equal(Object.getOwnPropertyDescriptor(env.Screen.prototype, 'availWidth').get, env.originals.availWidth);
  assert.equal(Object.getOwnPropertyDescriptor(env.host, 'screenX').get, env.originals.screenX);
  assert.equal(ctx.measureText('probe').width, METRICS.width);
  assert.deepEqual((await canvas.convertToBlob()).data, canvas.pixels);
  assert.equal(new env.WebGL2RenderingContext().getParameter(0x1f02), 'WebGL 2.0 native');
});

test('missing OffscreenCanvas support does not prevent the other patches from installing', () => {
  const env = setup({ offscreen: false });
  assert.notEqual(new env.HTMLCanvasElement().getContext('2d').measureText('probe').width, METRICS.width);
  assert.equal(new env.WebGL2RenderingContext().getParameter(0x1f02), 'WebGL 2.0');
  assert.equal(env.screen.availWidth, env.screen.width);
});

for (const name of ['Element', 'Range']) {
  test(`${name} rect damping is opt-in, stable, bounded, and keeps native containers`, () => {
    const env = setup();
    const node = new env[name]();
    const real = node.getBoundingClientRect().toJSON();
    assert.deepEqual(node.getClientRects().item(0).toJSON(), real);
    env.configure({ settings: { clientRects: true } });
    const rect = node.getBoundingClientRect();
    const list = node.getClientRects();
    assert.ok(rect instanceof env.DOMRect);
    assert.ok(list instanceof env.DOMRectList);
    assert.equal(list.item(0), list[0]);
    assert.equal([...list][0], list[0]);
    assert.equal(list.item(1), null);
    for (const field of ['x', 'y', 'width', 'height']) {
      assert.notEqual(rect[field], real[field]);
      assert.ok(Math.abs(rect[field] - real[field]) < 0.01);
    }
    assert.deepEqual(list[0].toJSON(), rect.toJSON());
    assert.deepEqual(node.getBoundingClientRect().toJSON(), rect.toJSON());
    assert.equal(rect.right, rect.x + rect.width);
    assert.equal(rect.bottom, rect.y + rect.height);
    assert.deepEqual(JSON.parse(JSON.stringify(rect)), rect.toJSON());
    assert.throws(() => env[name].prototype.getClientRects.call({}), /illegal receiver/);
    env.configure({ settings: { clientRects: false } });
    assert.deepEqual(node.getBoundingClientRect().toJSON(), real);
    assert.deepEqual(node.getClientRects()[0].toJSON(), real);
  });
}

test('multiline client rects stay coherent with bounds without changing source geometry', () => {
  const env = setup();
  const boxes = [[-10.5, 15.25, 20.75, 17.5], [-10.5, 32.75, 12.25, 17.5]];
  const node = new env.Range(boxes);
  env.configure({ settings: { clientRects: true } });
  const bounds = node.getBoundingClientRect();
  const list = [...node.getClientRects()];
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
  close(Math.min(...list.map(r => r.left)), bounds.left);
  close(Math.max(...list.map(r => r.right)), bounds.right);
  close(Math.min(...list.map(r => r.top)), bounds.top);
  close(Math.max(...list.map(r => r.bottom)), bounds.bottom);
  close(list[0].bottom, list[1].top);
  assert.deepEqual(env.originals.rangeRects.call(node)[0].toJSON(), new env.DOMRect(...boxes[0]).toJSON());
  node.boxes = [[100, 200, 300, 400]];
  assert.ok(Math.abs(node.getBoundingClientRect().x - 100) < 0.01);
});

test('rect damping preserves empty, collapsed and very small dimensions', () => {
  const env = setup();
  env.configure({ settings: { clientRects: true } });
  assert.deepEqual(new env.Element([]).getBoundingClientRect().toJSON(), new env.DOMRect().toJSON());
  assert.equal(new env.Element([]).getClientRects().length, 0);
  for (const boxes of [[[12, 30, 0, 17]], [[12, 30, 20, 0]], [[12, 30, 0.0001, 0.0002]]]) {
    const node = new env.Range(boxes);
    const rect = node.getBoundingClientRect();
    assert.ok(rect.width >= 0 && rect.height >= 0);
    assert.equal(rect.width === 0, boxes[0][2] === 0);
    assert.equal(rect.height === 0, boxes[0][3] === 0);
    const item = node.getClientRects()[0];
    // Native bounding unions can themselves differ by a few floating-point ulps.
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(rect[key] - item[key]) < 1e-10);
  }
});

test('rect seeds rotate with origin, day and session salt', () => {
  const bounds = env => {
    env.configure({ settings: { clientRects: true } });
    return new env.Element().getBoundingClientRect().toJSON();
  };
  const env = setup();
  const first = bounds(env);
  assert.deepEqual(bounds(setup()), first);
  assert.notDeepEqual(bounds(setup({ origin: 'https://two.example' })), first);
  assert.notDeepEqual(bounds(setup({ day: '2026-09-06' })), first);
  env.configure({ salt: 'new-session' });
  assert.notDeepEqual(bounds(env), first);
});

test('native Intl defaults are untouched until opted in', () => {
  const env = setup();
  assert.equal(env.evaluate(`
    new Intl.NumberFormat().format(12345.6) === new nativeIntl.NumberFormat().format(12345.6) &&
    new Intl.DateTimeFormat().resolvedOptions().timeZone === new nativeIntl.DateTimeFormat().resolvedOptions().timeZone &&
    (12345.6).toLocaleString() === nativeLocaleMethods.number.call(12345.6) &&
    'i'.toLocaleUpperCase() === nativeLocaleMethods.upper.call('i')
  `), true);
});

test('all available Intl formatters use en-US defaults with empty and unsupported locale lists', () => {
  const env = setup();
  env.configure({ settings: { language: true } });
  const locales = JSON.parse(env.evaluate(`JSON.stringify(
    ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat',
     'ListFormat', 'Segmenter', 'DisplayNames', 'DurationFormat'].filter(name => Intl[name]).flatMap(name =>
      [undefined, [], { length: 0 }, 'zz-ZZ', ['zz-ZZ']].map(locales => {
        const options = name === 'DisplayNames' ? { type: 'language' } : undefined;
        return { name, actual: new Intl[name](locales, options).resolvedOptions().locale,
          expected: new nativeIntl[name]('en-US', options).resolvedOptions().locale };
      }))
  )`));
  assert.ok(locales.length >= 40);
  // Native locale resolution may reduce en-US to en (e.g. PluralRules).
  assert.ok(locales.every(({ actual, expected }) => actual === expected), JSON.stringify(locales));
  assert.equal(env.evaluate('Intl.Locale === nativeIntl.Locale && Intl.getCanonicalLocales === nativeIntl.getCanonicalLocales'), true);
});

test('explicit locales, Unicode extensions and static locale support methods remain native', () => {
  const env = setup();
  env.configure({ settings: { language: true } });
  assert.equal(env.evaluate(`
    new Intl.NumberFormat(['de-DE', 'en-US']).resolvedOptions().locale === 'de-DE' &&
    new Intl.NumberFormat(new Intl.Locale('de-DE')).resolvedOptions().locale === 'de-DE' &&
    new Intl.NumberFormat('en-US-u-nu-arab').resolvedOptions().numberingSystem === 'arab' &&
    new Intl.Collator('sv-SE').compare('ä', 'z') > 0 &&
    Intl.NumberFormat.supportedLocalesOf === nativeIntl.NumberFormat.supportedLocalesOf &&
    Intl.NumberFormat.supportedLocalesOf('zz-ZZ').length === 0 &&
    'i'.toLocaleUpperCase('tr') === '\u0130'
  `), true);
});

test('actual formatting, collation, casing, arrays and built-in toLocale methods agree', () => {
  const env = setup();
  env.configure({ settings: { language: true } });
  assert.equal(env.evaluate(`(() => {
    const number = new nativeIntl.NumberFormat('en-US');
    const date = new Date('2026-09-05T12:34:56Z');
    return new Intl.NumberFormat().format(12345.6) === number.format(12345.6) &&
      (12345.6).toLocaleString() === number.format(12345.6) &&
      (12345n).toLocaleString() === number.format(12345n) &&
      [12345, 6789].toLocaleString() === [number.format(12345), number.format(6789)].join(',') &&
      new Uint32Array([12345, 6789]).toLocaleString() === [number.format(12345), number.format(6789)].join(',') &&
      date.toLocaleString() === nativeLocaleMethods.date.call(date, 'en-US') &&
      date.toLocaleDateString() === nativeLocaleMethods.dateOnly.call(date, 'en-US') &&
      date.toLocaleTimeString() === nativeLocaleMethods.timeOnly.call(date, 'en-US') &&
      new Intl.DateTimeFormat().format(date) === new nativeIntl.DateTimeFormat('en-US').format(date) &&
      'ä'.localeCompare('z') === new nativeIntl.Collator('en-US').compare('ä', 'z') &&
      'i'.toLocaleUpperCase() === 'I' && 'I'.toLocaleLowerCase() === 'i';
  })()`), true);
});

test('Intl constructors preserve calls, subclasses, bound methods and constructor references', () => {
  const env = setup();
  env.configure({ settings: { language: true } });
  assert.equal(env.evaluate(`(() => {
    class Format extends Intl.NumberFormat {}
    const f = new Format();
    const call = Intl.NumberFormat();
    const receiver = Object.create(Intl.NumberFormat.prototype);
    const chain = Intl.NumberFormat.call(receiver);
    const expected = new nativeIntl.NumberFormat('en-US').format(12345.6);
    return f instanceof Format && f instanceof Intl.NumberFormat &&
      f.format(12345.6) === expected && call.format(12345.6) === expected && chain === receiver &&
      call.constructor === Intl.NumberFormat && new call.constructor().format(12345.6) === expected &&
      Intl.NumberFormat.name === 'NumberFormat' && Intl.NumberFormat.length === nativeIntl.NumberFormat.length;
  })()`), true);
  assert.equal(env.evaluate(`(() => {
    const locales = { get length() { throw new Error('must not be read'); } };
    try { Intl.PluralRules(locales); } catch (e) { return e instanceof TypeError; }
    return false;
  })()`), true);
});

test('locale getters are consumed once and formatting options are not mutated', () => {
  const env = setup();
  env.configure({ settings: { language: true } });
  assert.equal(env.evaluate(`(() => {
    let lengthReads = 0, itemReads = 0;
    const locales = { get length() { lengthReads++; return 1; },
                      get 0() { itemReads++; return 'de-DE'; } };
    const options = Object.freeze({ style: 'currency', currency: 'EUR' });
    const result = new Intl.NumberFormat(locales, options);
    return lengthReads === 1 && itemReads === 1 && result.resolvedOptions().locale === 'de-DE' &&
      result.format(1234.5) === new nativeIntl.NumberFormat('de-DE', options).format(1234.5);
  })()`), true);
});

test('UTC config changes actual date formatting, while explicit zones remain coherent', () => {
  const env = setup();
  env.evaluate('globalThis.earlierFormatter = new Intl.DateTimeFormat();');
  env.configure({ settings: { language: true, timezone: true } });
  assert.equal(env.evaluate(`(() => {
    const date = new Date('2026-09-05T23:30:00Z');
    const options = { dateStyle: 'short', timeStyle: 'long' };
    const format = new Intl.DateTimeFormat(undefined, options);
    const explicit = { ...options, timeZone: 'America/New_York' };
    return format.resolvedOptions().timeZone === 'UTC' &&
      format.format(date) === new nativeIntl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(date) &&
      date.toLocaleString() === nativeLocaleMethods.date.call(date, 'en-US', { timeZone: 'UTC' }) &&
      date.toLocaleDateString() === nativeLocaleMethods.dateOnly.call(date, 'en-US', { timeZone: 'UTC' }) &&
      date.toLocaleTimeString() === nativeLocaleMethods.timeOnly.call(date, 'en-US', { timeZone: 'UTC' }) &&
      new Intl.DateTimeFormat(undefined, explicit).resolvedOptions().timeZone === 'America/New_York' &&
      new Intl.DateTimeFormat(undefined, explicit).format(date) === new nativeIntl.DateTimeFormat('en-US', explicit).format(date) &&
      earlierFormatter.resolvedOptions().timeZone === new nativeIntl.DateTimeFormat().resolvedOptions().timeZone &&
      date.getTimezoneOffset() === 0;
  })()`), true);
  env.configure({ settings: { timezone: false, language: false } });
  assert.equal(env.evaluate(`
    new Intl.DateTimeFormat().resolvedOptions().timeZone === new nativeIntl.DateTimeFormat().resolvedOptions().timeZone &&
    new Date().getTimezoneOffset() === nativeLocaleMethods.offset.call(new Date()) &&
    new Intl.NumberFormat().resolvedOptions().locale === new nativeIntl.NumberFormat().resolvedOptions().locale
  `), true);
});

test('timezone option defaults preserve frozen objects, inherited options and getter receivers', () => {
  const env = setup();
  env.configure({ settings: { timezone: true } });
  assert.equal(env.evaluate(`(() => {
    let reads = 0, correctThis = true;
    const options = Object.create({ year: 'numeric', month: 'long' });
    Object.defineProperty(options, 'timeZone', {
      get() { reads++; correctThis = this === options; return undefined; }
    });
    const format = new Intl.DateTimeFormat(undefined, options);
    const frozen = Object.freeze({ timeZone: undefined });
    return reads === 1 && correctThis && format.resolvedOptions().month === 'long' &&
      format.resolvedOptions().timeZone === 'UTC' &&
      new Intl.DateTimeFormat(undefined, frozen).resolvedOptions().timeZone === 'UTC' && frozen.timeZone === undefined &&
      new Intl.DateTimeFormat(undefined, 1).resolvedOptions().timeZone === 'UTC';
  })()`), true);
});

test('locale wrappers preserve invalid-input errors, native brand checks and coercion order', () => {
  const env = setup();
  env.configure({ settings: { language: true, timezone: true } });
  assert.equal(env.evaluate(`(() => {
    let reads = 0;
    const locales = { get length() { reads++; throw new Error('locale read'); } };
    const throwsType = fn => { try { fn(); } catch (e) { return e instanceof TypeError; } return false; };
    const throwsRange = fn => { try { fn(); } catch (e) { return e instanceof RangeError; } return false; };
    return throwsType(() => Number.prototype.toLocaleString.call({}, locales)) &&
      throwsType(() => String.prototype.localeCompare.call(Symbol(), 'x', locales)) &&
      throwsType(() => String.prototype.localeCompare.call('x', Symbol(), locales)) &&
      throwsType(() => String.prototype.toLocaleUpperCase.call(null, locales)) &&
      throwsType(() => Date.prototype.toLocaleString.call({}, locales)) &&
      new Date(NaN).toLocaleString(locales) === 'Invalid Date' &&
      Number.isNaN(new Date(NaN).getTimezoneOffset()) && reads === 0 &&
      throwsRange(() => new Intl.NumberFormat('bad_tag')) &&
      throwsType(() => new Intl.DateTimeFormat(undefined, null)) &&
      throwsRange(() => new Intl.DateTimeFormat(undefined, { timeZone: 'not-a-zone' })) &&
      [].toLocaleString('bad_tag') === '';
  })()`), true);
  assert.equal(env.evaluate(`(() => {
    const calls = [];
    const first = { toString() { calls.push('first'); return 'ä'; } };
    const second = { toString() { calls.push('second'); return 'z'; } };
    const locales = { get length() { calls.push('locales'); return 0; } };
    String.prototype.localeCompare.call(first, second, locales);
    return calls.join(',') === 'first,second,locales';
  })()`), true);
});

test('allowlisting restores rect methods, Intl constructors, prototype references and locale methods', () => {
  const env = setup();
  env.configure({ settings: { clientRects: true, language: true, timezone: true } });
  env.configure({ allowlisted: true });
  assert.equal(env.Element.prototype.getBoundingClientRect, env.originals.elementBounds);
  assert.equal(env.Element.prototype.getClientRects, env.originals.elementRects);
  assert.equal(env.Range.prototype.getBoundingClientRect, env.originals.rangeBounds);
  assert.equal(env.Range.prototype.getClientRects, env.originals.rangeRects);
  assert.equal(env.evaluate(`
    Intl.NumberFormat === nativeIntl.NumberFormat && Intl.DateTimeFormat === nativeIntl.DateTimeFormat &&
    Intl.Collator === nativeIntl.Collator && Intl.NumberFormat.prototype.constructor === nativeIntl.NumberFormat &&
    Intl.DateTimeFormat.prototype.constructor === nativeIntl.DateTimeFormat &&
    Number.prototype.toLocaleString === nativeLocaleMethods.number &&
    Date.prototype.toLocaleString === nativeLocaleMethods.date &&
    String.prototype.localeCompare === nativeLocaleMethods.compare &&
    String.prototype.toLocaleUpperCase === nativeLocaleMethods.upper
  `), true);
});

test('experimental Math rounding does not change canvas/rect noise or locale formatting', () => {
  const env = setup();
  env.configure({ settings: { canvas: true, clientRects: true, language: true, timezone: true } });
  const read = () => env.evaluate(`JSON.stringify({
    pixels: Array.from(new OffscreenCanvas().getContext('2d').getImageData(0, 0, 60, 20).data),
    text: new HTMLCanvasElement().getContext('2d').measureText('probe').width,
    rect: new Element().getBoundingClientRect().toJSON(),
    number: new Intl.NumberFormat().format(12345.6),
    date: new Date('2026-09-05T23:30:00Z').toLocaleString()
  })`);
  const first = read();
  env.configure({ settings: { mathRounding: true } });
  assert.equal(read(), first);
});
