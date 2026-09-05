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
 * and browser-enforced network/CSP policy (separate from page-world hooks).
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
  speechVoices: false,
  mediaDevices: false,
  permissionStates: false,
  mathRounding: false,
  stats: true,
  ...FPDLockdown.defaults
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
  webrtc: 'WebRTC IP leak',
  speechVoices: 'Speech voice list',
  mediaDevices: 'Media device list',
  permissionStates: 'Permission state',
  mathRounding: 'Math rounding'
};

async function getSettings() {
  const stored = await api.storage.local.get('settings');
  const values = stored.settings || {};
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key,
    Object.hasOwn(values, key) && typeof values[key] === 'boolean' ? values[key] : fallback]));
}

async function getAllowlist() {
  const stored = await api.storage.local.get('allowlist');
  return Array.isArray(stored.allowlist) ? stored.allowlist : [];
}

function originOf(href) {
  try { const value = new URL(href).origin; return value === 'null' ? null : value; }
  catch (_) { return null; }
}

// Serialise writes, including event-page startup/restarts. Dynamic rule updates
// are atomic, but DNR + storage are not a single browser transaction: compensate
// on failure and surface rollback failures instead of displaying a false "Saved".
let mutations = Promise.resolve();
let policyStatus = { state: 'loading', error: null, ruleCount: null };
function enqueue(task) {
  const result = mutations.then(task);
  mutations = result.catch(() => {});
  return result;
}
function errorText(error) { return String(error && error.message || error); }
function owned(rules) { return rules.filter(rule => FPDLockdown.ruleIds.includes(rule.id)); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function sameRules(a, b) {
  const ordered = value => [...value].sort((x, y) => x.id - y.id).map(canonical);
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}
async function networkSnapshot() {
  const [rules, enabled] = await Promise.all([
    api.declarativeNetRequest.getDynamicRules(), api.declarativeNetRequest.getEnabledRulesets()
  ]);
  return { rules: owned(rules), adnets: enabled.includes('adnets') };
}
async function writeNetwork(wanted, previous) {
  if (!sameRules(wanted.rules, previous.rules)) {
    await api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: previous.rules.map(rule => rule.id), addRules: wanted.rules
    });
  }
  if (wanted.adnets !== previous.adnets) {
    await api.declarativeNetRequest.updateEnabledRulesets(wanted.adnets
      ? { enableRulesetIds: ['adnets'] } : { disableRulesetIds: ['adnets'] });
  }
}
async function applySettings(settings, persist) {
  let previous;
  try {
    previous = await networkSnapshot();
    const wanted = { rules: FPDLockdown.buildRules(settings), adnets: settings.netBlock };
    await writeNetwork(wanted, previous);
    if (persist) await api.storage.local.set({ settings });
    policyStatus = { state: 'synced', error: null, ruleCount: wanted.rules.length };
    return { ok: true };
  } catch (error) {
    let message = errorText(error);
    if (previous) {
      try {
        await writeNetwork(previous, await networkSnapshot());
        message += ' Previous network rules restored; reload pages loaded during this attempt.';
      } catch (rollback) {
        message += ' ROLLBACK FAILED: ' + errorText(rollback) + '. Disable the extension to recover.';
      }
    }
    policyStatus = { state: 'error', error: message, ruleCount: null };
    return { ok: false, error: message };
  }
}
function fromExtensionPage(sender) {
  return sender.id === api.runtime.id && typeof sender.url === 'string' &&
    sender.url.startsWith(api.runtime.getURL(''));
}
function publicSettings(settings) {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !FPDLockdown.keys.includes(key)));
}
async function changeSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).some(key => !Object.hasOwn(DEFAULTS, key) || typeof patch[key] !== 'boolean')) {
    return { ok: false, error: 'Settings must contain known boolean controls only.' };
  }
  const settings = Object.assign(await getSettings(), patch);
  const result = await applySettings(settings, true);
  if (result.ok) {
    try { await broadcast(); }
    catch (error) { result.warning = 'Saved, but live page updates failed: ' + errorText(error) + '. Reload affected pages.'; }
  }
  return result;
}

// ------------------------------------------------------------------ messages
api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return;
  if (['popupData', 'setSettings', 'toggleAllowlist', 'disableLockdown'].includes(msg.type) &&
      !fromExtensionPage(sender)) {
    return Promise.resolve({ ok: false, error: 'This action requires an extension page.' });
  }

  if (msg.type === 'getConfig') {
    return (async () => {
      const [settings, allowlist] = await Promise.all([getSettings(), getAllowlist()]);
      const origin = originOf(sender.url);
      return { salt: SESSION_SALT, settings: publicSettings(settings),
        allowlisted: !!origin && allowlist.includes(origin) };
    })();
  }

  if (msg.type === 'stats' && sender.tab) {
    if (!msg.counts || typeof msg.counts !== 'object') return;
    const counts = {};
    for (const key of Object.keys(LABELS)) {
      if (Object.hasOwn(msg.counts, key) && Number.isSafeInteger(msg.counts[key]) && msg.counts[key] >= 0) {
        counts[key] = Math.min(msg.counts[key], 1000000);
      }
    }
    const id = sender.tab.id;
    const origin = originOf(sender.tab.url || sender.url) || '';
    const entry = tabStats.get(id);
    if (!entry || entry.origin !== origin) tabStats.set(id, { origin, counts });
    else for (const key of Object.keys(counts)) entry.counts[key] = Math.max(entry.counts[key] || 0, counts[key]);
    updateBadge(id);
    return;
  }

  if (msg.type === 'popupData') {
    return enqueue(async () => {
      const [settings, allowlist] = await Promise.all([getSettings(), getAllowlist()]);
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const origin = tab ? originOf(tab.url) : null;
      const entry = tab ? tabStats.get(tab.id) : null;
      return { origin, settings, labels: LABELS, policyStatus,
        allowlisted: !!origin && allowlist.includes(origin), counts: entry ? entry.counts : {} };
    });
  }

  if (msg.type === 'setSettings') return enqueue(() => changeSettings(msg.settings));
  if (msg.type === 'disableLockdown') return enqueue(() => changeSettings(FPDLockdown.defaults));

  if (msg.type === 'toggleAllowlist') {
    return enqueue(async () => {
      const origin = msg.origin;
      if (!origin || originOf(origin) !== origin) return { ok: false, error: 'Invalid origin.' };
      const list = await getAllowlist();
      const idx = list.indexOf(origin);
      if (idx >= 0) list.splice(idx, 1); else list.push(origin);
      await api.storage.local.set({ allowlist: list });
      // Deliberately do not change global network/CSP rules or create allow rules.
      let warning;
      try { await broadcast(); }
      catch (error) { warning = 'Saved, but live updates failed: ' + errorText(error) + '. Reload affected pages.'; }
      return { ok: true, allowlisted: idx < 0, ...(warning ? { warning } : {}) };
    });
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
  if (info.status === 'loading') {
    tabStats.delete(id);
    updateBadge(id);
  }
});

async function reconcile(persist = false) {
  try { return await applySettings(await getSettings(), persist); }
  catch (error) {
    policyStatus = { state: 'error', error: errorText(error), ruleCount: null };
    return { ok: false, error: policyStatus.error };
  }
}
// Dynamic rules survive browser restarts and extension updates. Reconcile on
// every event-page start, and migrate defaults on install/update. Never auto-enable
// a lockdown control, clear site data, unregister workers or reload user tabs.
enqueue(() => reconcile());
api.runtime.onInstalled.addListener(() => enqueue(() => reconcile(true)));