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

/*
 * Fingerprint Damper - background event page.
 *
 * Owns: settings, per-origin allowlist, the per-session salt, per-tab counters
 * and the declarativeNetRequest ruleset toggle.
 */

const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULTS = {
  canvas: true,
  webgl: true,
  audio: true,
  geometry: true,
  concurrency: true,
  battery: true,
  pushGuard: true,
  netBlock: true,
  clientRects: false,
  timezone: false,
  language: false,
  webrtc: false,
  stats: true
};

// Rotates every browser session, so a site cannot link today's canvas hash to
// yesterday's. Never persisted.
const SESSION_SALT = Math.random().toString(36).slice(2) + Date.now().toString(36);

// tabId -> { origin, counts }
const tabStats = new Map();

const LABELS = {
  canvas: 'Canvas / text metrics',
  clientRects: 'Client rects',
  webgl: 'GPU string',
  audio: 'Audio sampling',
  battery: 'Battery status',
  notify: 'Notification prompt',
  swblock: 'Ad service worker',
  timezone: 'Timezone',
  language: 'Language / locale',
  webrtc: 'WebRTC IP leak'
};

async function getSettings() {
  const stored = await api.storage.local.get('settings');
  return Object.assign({}, DEFAULTS, stored.settings || {});
}

async function getAllowlist() {
  const stored = await api.storage.local.get('allowlist');
  return Array.isArray(stored.allowlist) ? stored.allowlist : [];
}

function originOf(href) {
  try { return new URL(href).origin; } catch (_) { return null; }
}

// ------------------------------------------------------------------ messages
api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;

  if (msg.type === 'getConfig') {
    return (async () => {
      const [settings, allowlist] = await Promise.all([getSettings(), getAllowlist()]);
      const origin = originOf(msg.href || (sender.url || ''));
      return {
        salt: SESSION_SALT,
        settings,
        allowlisted: !!origin && allowlist.includes(origin)
      };
    })();
  }

  if (msg.type === 'stats' && sender.tab) {
    const id = sender.tab.id;
    const origin = originOf(msg.href) || '';
    const entry = tabStats.get(id);
    if (!entry || entry.origin !== origin) {
      tabStats.set(id, { origin, counts: Object.assign({}, msg.counts) });
    } else {
      // Frames report independently; keep the max per kind rather than summing
      // duplicates from repeated flushes of the same running total.
      for (const k of Object.keys(msg.counts)) {
        entry.counts[k] = Math.max(entry.counts[k] || 0, msg.counts[k]);
      }
    }
    updateBadge(id);
    return;
  }

  if (msg.type === 'popupData') {
    return (async () => {
      const [settings, allowlist] = await Promise.all([getSettings(), getAllowlist()]);
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const origin = tab ? originOf(tab.url) : null;
      const entry = tab ? tabStats.get(tab.id) : null;
      return {
        origin,
        settings,
        labels: LABELS,
        allowlisted: !!origin && allowlist.includes(origin),
        counts: entry ? entry.counts : {}
      };
    })();
  }

  if (msg.type === 'setSettings') {
    return (async () => {
      const settings = Object.assign(await getSettings(), msg.settings || {});
      await api.storage.local.set({ settings });
      await api.declarativeNetRequest.updateEnabledRulesets(
        settings.netBlock
          ? { enableRulesetIds: ['adnets'] }
          : { disableRulesetIds: ['adnets'] }
      ).catch(() => {});
      await broadcast();
      return { ok: true };
    })();
  }

  if (msg.type === 'toggleAllowlist') {
    return (async () => {
      const origin = msg.origin;
      if (!origin) return { ok: false };
      const list = await getAllowlist();
      const idx = list.indexOf(origin);
      if (idx >= 0) list.splice(idx, 1); else list.push(origin);
      await api.storage.local.set({ allowlist: list });
      await broadcast();
      return { ok: true, allowlisted: idx < 0 };
    })();
  }
});

async function broadcast() {
  const tabs = await api.tabs.query({});
  for (const t of tabs) {
    api.tabs.sendMessage(t.id, { type: 'configChanged' }).catch(() => {});
  }
}

// -------------------------------------------------------------------- badge
function updateBadge(tabId) {
  const entry = tabStats.get(tabId);
  let total = 0;
  if (entry) for (const k of Object.keys(entry.counts)) total += entry.counts[k];
  const text = total > 0 ? (total > 99 ? '99+' : String(total)) : '';
  api.action.setBadgeText({ tabId, text }).catch(() => {});
  api.action.setBadgeBackgroundColor({ tabId, color: '#2b5fd9' }).catch(() => {});
}

api.tabs.onRemoved.addListener((id) => tabStats.delete(id));
api.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'loading' && info.url) {
    tabStats.delete(id);
    updateBadge(id);
  }
});

api.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await api.storage.local.set({ settings });
});