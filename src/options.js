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

const api = typeof browser !== 'undefined' ? browser : chrome;

const SAFE = [
  ['canvas', 'Canvas noise',
   'Flips the low bit of 32 pixels on readback. Invisible to you, changes the hash.'],
  ['webgl', 'Mask GPU string',
   'Reports the renderer as "Mozilla", matching Firefox\u2019s own resistFingerprinting crowd.'],
  ['audio', 'Audio noise',
   'Perturbs ~32 samples by 1e-7. Inaudible; defeats AudioContext hashing.'],
  ['geometry', 'Normalise window geometry',
   'Zeroes window position, reports outer size as inner size, flattens colour depth. Screen resolution is left real so responsive layouts still work.'],
  ['concurrency', 'Fix CPU core count',
   'Always reports 8 cores.'],
  ['battery', 'Neutralise Battery API',
   'Always reports full and charging. Battery level is a strong short-term cross-site correlator.'],
  ['pushGuard', 'Block push-ad funnels',
   'Silently dismisses notification permission requests and blocks known ad service workers.'],
  ['netBlock', 'Block known push-ad networks',
   'Network-level block for the RTMark/PropellerAds hosts. Converter sites keep working \u2014 only the ad layer is cut.'],
  ['stats', 'Count activity for the popup',
   'Slightly increases detectability, since it needs a page-visible event channel. Turn off for a quieter profile.']
];

const RISKY = [
  ['timezone', 'Force UTC timezone', 'Breaks calendars, bookings and delivery estimates.'],
  ['language', 'Force en-US language', 'Sites may stop showing your language.'],
  ['webrtc', 'Block WebRTC IP leaks',
   'Strips your public IP from WebRTC ICE candidates. Breaks peer-to-peer calling apps with no TURN server \u2014 most big ones (Meet, Zoom, Discord) have one and are fine.']
];

let settings = {};

function build(container, defs) {
  for (const [key, title, desc] of defs) {
    const label = document.createElement('label');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings[key];
    cb.addEventListener('change', () => save(key, cb.checked));

    const text = document.createElement('div');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = title;
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = desc;
    text.append(t, d);

    label.append(cb, text);
    container.appendChild(label);
  }
}

let toastTimer = null;
async function save(key, value) {
  settings[key] = value;
  await api.runtime.sendMessage({ type: 'setSettings', settings: { [key]: value } });
  const el = document.getElementById('saved');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

(async () => {
  const data = await api.runtime.sendMessage({ type: 'popupData' });
  settings = (data && data.settings) || {};
  build(document.getElementById('safe'), SAFE);
  build(document.getElementById('risky'), RISKY);
})();