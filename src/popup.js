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

let current = null;

function render(data) {
  current = data;

  document.getElementById('origin').textContent = data.origin || 'No page';

  const box = document.getElementById('counts');
  box.textContent = '';
  const keys = Object.keys(data.counts || {}).filter((k) => data.counts[k] > 0);

  if (!keys.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = data.allowlisted ? 'API patches paused on this site.' : 'No API counts yet.';
    box.appendChild(d);
  } else {
    for (const k of keys) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = (data.labels && data.labels[k]) || k;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = data.counts[k];
      row.append(label, n);
      box.appendChild(row);
    }
  }

  const btn = document.getElementById('allow');
  btn.disabled = !data.origin;
  btn.textContent = data.allowlisted ? 'Resume API patches on this site' : 'Pause API patches on this site';
  btn.classList.toggle('on', !!data.allowlisted);
  const count = FPDLockdown.keys.filter(key => data.settings && data.settings[key]).length;
  const status = data.policyStatus || {};
  document.getElementById('policy-status').textContent = status.state === 'error'
    ? 'Policy error: ' + status.error
    : status.state === 'synced'
      ? count ? `${count} controls selected globally; ${status.ruleCount} rules configured. Not an enforcement test.`
        : 'Global lockdown off.'
      : 'Browser rules are not confirmed yet.';
}

async function load() {
  const data = await api.runtime.sendMessage({ type: 'popupData' });
  if (!data || !data.settings) throw new Error('Unable to read settings.');
  render(data);
}

let busy = false;
async function action(run) {
  if (busy) return;
  busy = true;
  for (const id of ['allow', 'lock-off']) document.getElementById(id).disabled = true;
  document.getElementById('action-error').textContent = '';
  try { await run(); }
  catch (error) { document.getElementById('action-error').textContent = error.message; }
  finally {
    busy = false;
    document.getElementById('lock-off').disabled = false;
    document.getElementById('allow').disabled = !current || !current.origin;
  }
}
document.getElementById('allow').addEventListener('click', () => action(async () => {
  if (!current || !current.origin) return;
  const result = await api.runtime.sendMessage({ type: 'toggleAllowlist', origin: current.origin });
  if (!result || !result.ok) throw new Error(result && result.error || 'Pause failed.');
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) await api.tabs.reload(tabs[0].id);
  window.close();
}));
document.getElementById('lock-off').addEventListener('click', () => action(async () => {
  const result = await api.runtime.sendMessage({ type: 'disableLockdown' });
  if (!result || !result.ok) throw new Error(result && result.error || 'Lockdown removal failed.');
  await load();
  if (current.policyStatus?.state === 'synced' && !FPDLockdown.keys.some(key => current.settings[key])) {
    document.getElementById('policy-status').textContent = 'Global lockdown off for future loads. Reload affected tabs (bypass cache).';
  }
  if (result.warning) document.getElementById('action-error').textContent = result.warning;
}));

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});

load().catch(error => { document.getElementById('action-error').textContent = error.message; });
