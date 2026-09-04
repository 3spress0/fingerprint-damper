/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. It is distributed WITHOUT ANY WARRANTY; without even the
 * implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License (LICENSE) for more details.
 */

/* Reads the exact surfaces the y2mate ad SDK's getBrowserStat() read. */

const rows = [];
function add(k, v, damped) {
  rows.push([k, v, damped]);
}

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

// --- GPU ---------------------------------------------------------------
let gpu = 'no webgl';
try {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
} catch (e) { gpu = 'error: ' + e.message; }
add('WebGL renderer', gpu, gpu === 'Mozilla');

// --- Canvas ------------------------------------------------------------
let canvasHash = 'n/a';
try {
  const c = document.createElement('canvas');
  c.width = 240; c.height = 60;
  const x = c.getContext('2d');
  x.textBaseline = 'top';
  x.font = '14px "Arial"';
  x.fillStyle = '#f60'; x.fillRect(10, 5, 80, 30);
  x.fillStyle = '#069'; x.fillText('Fingerprint\u00a0Damper \u2601', 12, 12);
  x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Fingerprint\u00a0Damper \u2601', 14, 20);
  canvasHash = hash(c.toDataURL());
} catch (e) { canvasHash = 'error'; }
add('Canvas hash (toDataURL)', canvasHash, null);

let pixelHash = 'n/a';
try {
  const c = document.createElement('canvas');
  c.width = 60; c.height = 20;
  const x = c.getContext('2d');
  x.fillStyle = '#123456'; x.fillRect(0, 0, 60, 20);
  pixelHash = hash(Array.from(x.getImageData(0, 0, 60, 20).data).join(','));
} catch (e) { pixelHash = 'error'; }
add('Canvas hash (getImageData)', pixelHash, null);

// --- Audio -------------------------------------------------------------
let audioHash = 'pending…';
add('AudioContext hash', audioHash, null);

// --- Hardware / geometry ----------------------------------------------
add('hardwareConcurrency', String(navigator.hardwareConcurrency), navigator.hardwareConcurrency === 8);
add('screen.width \u00d7 height', screen.width + ' \u00d7 ' + screen.height, null);
add('screen.avail \u2212 screen', (screen.width - screen.availWidth) + ' \u00d7 ' + (screen.height - screen.availHeight),
    screen.availWidth === screen.width && screen.availHeight === screen.height);
add('window.screenX / screenY', window.screenX + ' / ' + window.screenY,
    window.screenX === 0 && window.screenY === 0);
add('outer \u2212 inner', (window.outerWidth - window.innerWidth) + ' \u00d7 ' + (window.outerHeight - window.innerHeight),
    window.outerWidth === window.innerWidth && window.outerHeight === window.innerHeight);
add('screen.colorDepth', String(screen.colorDepth), screen.colorDepth === 24);

// --- Locale ------------------------------------------------------------
let tz = 'n/a';
try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
add('Timezone', tz + '  (offset ' + new Date().getTimezoneOffset() + ')', tz === 'UTC');
add('navigator.language', navigator.language, navigator.language === 'en-US');

// --- Bot signals the SDK checked (should stay natural) -----------------
add('navigator.plugins.length', String(navigator.plugins.length),
    navigator.plugins.length > 0 ? true : null);
add('navigator.webdriver', String(navigator.webdriver), navigator.webdriver === false);
add('maxTouchPoints', String(navigator.maxTouchPoints), null);

function paint() {
  const out = document.getElementById('out');
  out.textContent = '';
  for (const [k, v, damped] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.className = 'k';
    td1.textContent = k;
    const td2 = document.createElement('td');
    td2.className = 'v';
    td2.textContent = v;
    if (damped !== null) {
      const tag = document.createElement('span');
      tag.className = 'tag ' + (damped ? 'damped' : 'exposed');
      tag.textContent = damped ? 'damped' : 'exposed';
      td2.appendChild(tag);
    }
    tr.append(td1, td2);
    out.appendChild(tr);
  }
}
paint();

// --- Battery (async) ---------------------------------------------------
if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    rows.splice(rows.length, 0, ['Battery', 'level ' + b.level + ', charging ' + b.charging,
      b.level === 1 && b.charging === true]);
    paint();
  }).catch(() => {
    rows.push(['Battery', 'API rejected (good)', true]);
    paint();
  });
} else {
  rows.push(['Battery', 'API absent (good \u2014 Firefox default)', true]);
  paint();
}

// --- Audio (async) -----------------------------------------------------
try {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 44100, 44100);
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = 10000;
  const comp = ctx.createDynamicsCompressor();
  osc.connect(comp); comp.connect(ctx.destination);
  osc.start(0);
  ctx.startRendering().then((buf) => {
    const d = buf.getChannelData(0);
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
    const idx = rows.findIndex((r) => r[0] === 'AudioContext hash');
    rows[idx][1] = hash(String(sum));
    paint();
  });
} catch (e) {
  const idx = rows.findIndex((r) => r[0] === 'AudioContext hash');
  rows[idx][1] = 'error';
  paint();
}

// --- Notification prompt (must not show a dialog) ----------------------
setTimeout(() => {
  if (!window.Notification) return;
  if (Notification.permission !== 'default') {
    rows.push(['Notification.permission', Notification.permission, null]);
    paint();
    return;
  }
  Notification.requestPermission().then((r) => {
    rows.push(['requestPermission() returned', r + (r === 'default' ? '  (no dialog = damped)' : ''), r === 'default']);
    paint();
  });
}, 900);
