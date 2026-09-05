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
   'Adds small pixel and measureText() noise to main-thread canvases, including OffscreenCanvas. Changes exact hashes; does not hide installed fonts.'],
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
  ['speechVoices', 'Hide speech voice list',
   'getVoices() returns an empty list. Default speech remains native, but voice pickers and some accessibility features may stop working.'],
  ['mediaDevices', 'Hide media device list',
   'enumerateDevices() returns an empty list, hiding labels, counts and IDs. Does not block capture or change grants. Camera, microphone and speaker pickers may break.'],
  ['permissionStates', 'Mask passive permission states',
   'Supported PermissionStatus.state reads report prompt; Notification.permission reports default. Real grants, request outcomes and events remain native. Sites may show redundant permission UI or disable features.'],
  ['mathRounding', 'Reduce Math precision (experimental)',
   'Rounds low-order bits of transcendental, root and power results. Can change exact identities and break numerical code. Arithmetic, WebAssembly and workers remain native; not a complete math fingerprint defence.'],
  ['clientRects', 'Damp client rects',
   'Adds stable sub-pixel noise to Element/Range bounds. Can affect positioning, text selection and hit-testing. Changes exact hashes, not robust font detection.'],
  ['timezone', 'Default to UTC timezone',
   'Uses UTC for default date formatting and timezone offsets. Explicit time zones and other Date methods stay native. Can break calendars and bookings.'],
  ['language', 'Default to en-US language / locale',
   'Normalises navigator language, Intl defaults and built-in locale formatting. Supported explicit locale choices stay native. Sites may stop showing your language.'],
  ['webrtc', 'Block WebRTC IP leaks',
   'Strips your public IP from WebRTC ICE candidates. Breaks peer-to-peer calling apps with no TURN server \u2014 most big ones (Meet, Zoom, Discord) have one and are fine.']
];

let settings = {};
let busy = false;

function build(container, defs) {
  for (const [key, title, desc] of defs) {
    const label = document.createElement('label');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.key = key;
    cb.checked = !!settings[key];
    cb.addEventListener('change', () => save({ [key]: cb.checked }));

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
function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll('input,button')) control.disabled = value;
}
async function load() {
  const data = await api.runtime.sendMessage({ type: 'popupData' });
  if (!data || !data.settings) throw new Error('Unable to read settings.');
  settings = data.settings;
  for (const [id, defs] of [['safe', SAFE], ['risky', RISKY], ['lockdown', FPDLockdown.controls]]) {
    const container = document.getElementById(id);
    container.textContent = '';
    build(container, defs);
  }
  const status = data.policyStatus || {};
  const count = FPDLockdown.keys.filter(key => settings[key]).length;
  document.getElementById('policy-status').textContent = status.state === 'error'
    ? 'Network policy error: ' + status.error
    : status.state === 'synced'
      ? `${count} global lockdown controls selected; ${status.ruleCount} browser rules configured. Not an enforcement test.`
      : 'Browser rules are not confirmed yet.';
  setBusy(busy);
}
async function save(patch) {
  if (busy) return;
  setBusy(true);
  document.getElementById('save-error').textContent = '';
  const toast = document.getElementById('saved');
  toast.classList.remove('show');
  let saved = false;
  try {
    const result = await api.runtime.sendMessage({ type: 'setSettings', settings: patch });
    if (!result || !result.ok) throw new Error(result && result.error || 'No save confirmation.');
    saved = true;
    await load();
    if (result.warning) document.getElementById('save-error').textContent = result.warning;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
  } catch (error) {
    try { await load(); } catch (_) { /* Retain the explicit failure below. */ }
    document.getElementById('save-error').textContent = (saved ? 'Saved, but UI refresh failed: ' : 'Not saved: ') + error.message;
  } finally { setBusy(false); }
}
document.getElementById('lock-max').addEventListener('click', () => {
  if (busy || !window.confirm('Enable ALL global lockdown controls? Most sites may break or become blank. '
    + 'API pause will NOT disable these rules. Reload affected tabs after changing them.')) return;
  return save(Object.fromEntries(FPDLockdown.keys.map(key => [key, true])));
});
document.getElementById('lock-off').addEventListener('click', () => save({ ...FPDLockdown.defaults }));
load().catch(error => { document.getElementById('save-error').textContent = error.message; });
