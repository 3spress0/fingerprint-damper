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

// On by default: fingerprint damping with a low breakage profile.
const SAFE = [
  ['canvas', 'Canvas noise',
   'Adds small pixel and measureText() noise to main-thread canvases, including OffscreenCanvas. Changes exact hashes; does not hide installed fonts.'],
  ['webgl', 'Dampen WebGL identity / readback',
   'Masks vendor, renderer and version fields, hides WEBGL_debug_renderer_info, and stably changes standard RGBA/UNSIGNED_BYTE readPixels() output. Other WebGL capability and shader surfaces remain native.'],
  ['concurrency', 'Normalise hardware capacity',
   'Reports 8 CPU cores and, only where the browser already exposes it, 8 GB deviceMemory. It does not add APIs or patch worker navigators.'],
  ['battery', 'Neutralise Battery API',
   'Reports full and charging while retaining the native BatteryManager shell where available. Battery level is a strong short-term cross-site correlator.']
];

// Off by default: touches application data, prompts, workers or the network.
const RISKY = [
  ['stats', 'Count activity for the popup',
   'Off by default for a quieter profile: it needs a page-visible event channel, which slightly increases detectability. Enable it for toolbar activity counts.'],
  ['audio', 'Audio noise',
   'Perturbs ~32 samples by 1e-7 in AudioBuffer.getChannelData() results. That array is the buffer\'s real backing store, so audio apps that read or export those samples see tiny drift. Inaudible; defeats AudioContext hashing.'],
  ['geometry', 'Normalise window geometry',
   'Zeroes window position, reports outer size as inner size, flattens colour depth. Screen resolution is left real so responsive layouts still work.'],
  ['notify', 'Block notification permission prompts',
   'Requests that do not follow a deliberate click resolve "default" (no dialog), as if the user dismissed the prompt. Requests made right after a click still prompt normally.'],
  ['swBlock', 'Block ad service workers (experimental)',
   'Rejects service-worker registrations whose host labels or script path match known ad-SDK patterns. Off by default: pattern matching can hit unrelated apps; use the per-site pause as a bypass.'],
  ['netBlock', 'Block known ad / push networks',
   'Network-level block for 78 teardown and public-list ad/push domains. The expanded source-derived entries apply only to third-party requests; this is still narrower than a full ad blocker.'],
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
  ['webrtc', 'Block WebRTC address leaks',
   'Withholds host, server-reflexive and peer-reflexive ICE candidates from events, SDP and local stats; relay (TURN) paths remain. Local getStats() becomes a map-shaped sanitized copy. Peer-to-peer apps without TURN can fail.']
];

let settings = {};
let pausedOrigins = [];
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

function renderPausedSites(origins) {
  const container = document.getElementById('paused-sites');
  const resumeAll = document.getElementById('resume-all');
  container.textContent = '';
  resumeAll.hidden = !origins.length;
  if (!origins.length) {
    const empty = document.createElement('div');
    empty.className = 'd';
    empty.textContent = 'No sites are paused.';
    container.appendChild(empty);
    return;
  }
  for (const origin of origins) {
    const row = document.createElement('div');
    row.className = 'paused-site';
    const name = document.createElement('code');
    name.textContent = origin;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Resume API patches';
    button.addEventListener('click', () => resumePausedSite(origin));
    row.append(name, button);
    container.appendChild(row);
  }
}

let toastTimer = null;
function showSaved(message) {
  const toast = document.getElementById('saved');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}
function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll('input,button')) control.disabled = value;
}
async function load() {
  const [data, paused] = await Promise.all([
    api.runtime.sendMessage({ type: 'popupData' }),
    api.runtime.sendMessage({ type: 'getAllowlist' })
  ]);
  if (!data || !data.settings || !paused || !paused.ok || !Array.isArray(paused.allowlist)) {
    throw new Error('Unable to read settings.');
  }
  settings = data.settings;
  pausedOrigins = paused.allowlist;
  for (const [id, defs] of [['safe', SAFE], ['risky', RISKY], ['lockdown', FPDLockdown.controls]]) {
    const container = document.getElementById(id);
    container.textContent = '';
    build(container, defs);
  }
  renderPausedSites(pausedOrigins);
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
    showSaved('Saved — new pages and live hooks are updated; reload if a page cached results');
  } catch (error) {
    try { await load(); } catch (_) { /* Retain the explicit failure below. */ }
    document.getElementById('save-error').textContent = (saved ? 'Saved, but UI refresh failed: ' : 'Not saved: ') + error.message;
  } finally { setBusy(false); }
}

async function changePausedSites(type, origin) {
  if (busy) return;
  setBusy(true);
  document.getElementById('save-error').textContent = '';
  document.getElementById('saved').classList.remove('show');
  let saved = false;
  try {
    const result = await api.runtime.sendMessage({ type, ...(origin ? { origin } : {}) });
    if (!result || !result.ok) throw new Error(result && result.error || 'No save confirmation.');
    saved = true;
    await load();
    if (result.warning) document.getElementById('save-error').textContent = result.warning;
    showSaved('Pause/resume applied to open pages; reload only if a page cached earlier values');
  } catch (error) {
    try { await load(); } catch (_) { /* Retain the explicit failure below. */ }
    document.getElementById('save-error').textContent = (saved ? 'Saved, but UI refresh failed: ' : 'Not saved: ') + error.message;
  } finally { setBusy(false); }
}

function resumePausedSite(origin) {
  return changePausedSites('removeAllowlist', origin);
}
document.getElementById('lock-max').addEventListener('click', () => {
  if (busy || !window.confirm('Enable ALL global lockdown controls? Most sites may break or become blank. '
    + 'API pause will NOT disable these rules. Reload affected tabs after changing them.')) return;
  return save(Object.fromEntries(FPDLockdown.keys.map(key => [key, true])));
});
document.getElementById('lock-off').addEventListener('click', () => save({ ...FPDLockdown.defaults }));
document.getElementById('resume-all').addEventListener('click', () => {
  if (busy || !pausedOrigins.length || !window.confirm('Resume API patches on every paused site? '
    + 'Global ad-network and lockdown rules will stay unchanged.')) return;
  return changePausedSites('clearAllowlist');
});
load().catch(error => { document.getElementById('save-error').textContent = error.message; });
