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
    d.textContent = data.allowlisted ? 'Paused on this site.' : 'Nothing yet.';
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
  btn.textContent = data.allowlisted ? 'Resume on this site' : 'Pause on this site';
  btn.classList.toggle('on', !!data.allowlisted);
}

async function load() {
  const data = await api.runtime.sendMessage({ type: 'popupData' });
  if (data) render(data);
}

document.getElementById('allow').addEventListener('click', async () => {
  if (!current || !current.origin) return;
  await api.runtime.sendMessage({ type: 'toggleAllowlist', origin: current.origin });
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) api.tabs.reload(tabs[0].id);
  window.close();
});

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});

load();
