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
 * Owns: settings, per-origin allowlist, the per-browser-session salt, per-tab
 * counters and browser-enforced network/CSP policy (separate from page-world
 * hooks). The salt lives in storage.session, which is a trusted extension
 * context; content scripts read NOTHING from it directly (Firefox does not
 * expose storage.session to content scripts). Pages are configured through
 * the bridge's runtime message round trip instead.
 */

const api = typeof browser !== 'undefined' ? browser : chrome;

// v1.2.0 shipped profile: fingerprint damping on, everything that touches
// application data, prompts or the network is opt-in/experimental.
const DEFAULTS = {
  canvas: true,
  webgl: true,
  audio: false,
  geometry: false,
  concurrency: true,
  battery: true,
  notify: false,
  swBlock: false,
  netBlock: false,
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

/*
 * One salt per browser session.
 *
 * The MV3 background is an event page: module state (and any Math.random
 * here) is lost whenever it restarts, which would rotate the per-origin
 * persona mid-session. So the salt is generated once with
 * crypto.getRandomValues(), cached in memory, and mirrored into
 * storage.session, which the browser clears when the session ends.
 */
const SALT_RE = /^[0-9a-f]{64}$/;
const SESSION_KEY = 'fpdSession';   // { salt, settings, allowlist }

let sessionSalt = null;

function makeSalt() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readSession() {
  try {
    const got = await api.storage.session.get(SESSION_KEY);
    const value = got && got[SESSION_KEY];
    return value && typeof value === 'object' ? value : null;
  } catch (_) { return null; }
}

/*
 * Read (or create) the salt and mirror the full current state into
 * session storage:
 *   { salt, settings (public, lockdown keys excluded), allowlist }
 *
 * The mirror serves two purposes:
 *  - the SALT survives MV3 event-page restarts (Firefox keeps storage.session
 *    for the whole browser session and clears it on shutdown);
 *  - getConfig can answer from one consistent object.
 *
 * Everything here runs in the trusted background context. Content scripts
 * never read this mirror: Firefox does not expose storage.session to them
 * (and storage.session.setAccessLevel() is not supported there), so the
 * bridge always goes through runtime.sendMessage instead.
 */
async function sessionSnapshot() {
  if (!sessionSalt) {
    const existing = await readSession();
    if (existing && SALT_RE.test(existing.salt || '')) sessionSalt = existing.salt;
  }
  if (!sessionSalt) sessionSalt = makeSalt();
  const [settings, allowlist] = await Promise.all([getSettings(), getAllowlist()]);
  const value = {
    salt: sessionSalt,
    settings: publicSettings(settings),
    allowlist
  };
  try {
    await api.storage.session.set({ [SESSION_KEY]: value });
  } catch (_) {}
  return value;
}

// tabId -> { origin, counts }
const tabStats = new Map();

const LABELS = {
  canvas: 'Canvas / text metrics',
  clientRects: 'Client rects',
  webgl: 'WebGL identity/readback',
  audio: 'Audio sampling',
  battery: 'Battery status',
  notify: 'Notification prompt',
  swblock: 'Ad service worker',
  timezone: 'Timezone',
  language: 'Language / locale',
  webrtc: 'WebRTC address leak',
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

function originOf(href) {
  try { const value = new URL(href).origin; return value === 'null' ? null : value; }
  catch (_) { return null; }
}

function isCanonicalOrigin(value) {
  return typeof value === 'string' && originOf(value) === value;
}

async function getAllowlist() {
  const stored = await api.storage.local.get('allowlist');
  // Only canonical origins can be written through this extension. Filter stale
  // or malformed old storage values here so Settings never renders an entry it
  // cannot safely remove, and deduplicate a hand-edited/legacy list.
  const list = Array.isArray(stored.allowlist) ? stored.allowlist : [];
  return [...new Set(list.filter(isCanonicalOrigin))].sort();
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
    // Refresh the session mirror first; live pages are then re-served through
    // their bridge round trip, which answers from it.
    await sessionSnapshot();
    try { await broadcast(); }
    catch (error) { result.warning = 'Saved, but live page updates failed: ' + errorText(error) + '. Reload affected pages.'; }
  }
  return result;
}

async function saveAllowlist(list) {
  await api.storage.local.set({ allowlist: list });
  // Deliberately do not change global network/CSP rules or create allow rules.
  try {
    await sessionSnapshot();
    await broadcast();
    return { ok: true };
  } catch (error) {
    return { ok: true, warning: 'Saved, but live updates failed: ' + errorText(error) + '. Reload affected pages.' };
  }
}

// ------------------------------------------------------------------ messages
api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return;
  if (['popupData', 'getAllowlist', 'setSettings', 'toggleAllowlist', 'removeAllowlist',
       'clearAllowlist', 'disableLockdown'].includes(msg.type) && !fromExtensionPage(sender)) {
    return Promise.resolve({ ok: false, error: 'This action requires an extension page.' });
  }

  if (msg.type === 'getConfig') {
    return (async () => {
      // (Re)create the browser-session salt and mirror on first use, then
      // answer the bridge from it.
      const snapshot = await sessionSnapshot();
      const origin = originOf(sender.url);
      return { salt: snapshot.salt, settings: snapshot.settings,
        allowlisted: !!origin && snapshot.allowlist.includes(origin) };
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

  if (msg.type === 'getAllowlist') {
    return enqueue(async () => ({ ok: true, allowlist: await getAllowlist() }));
  }

  if (msg.type === 'setSettings') return enqueue(() => changeSettings(msg.settings));
  if (msg.type === 'disableLockdown') return enqueue(() => changeSettings(FPDLockdown.defaults));

  if (msg.type === 'toggleAllowlist') {
    return enqueue(async () => {
      const origin = msg.origin;
      if (!isCanonicalOrigin(origin)) return { ok: false, error: 'Invalid origin.' };
      const list = await getAllowlist();
      const idx = list.indexOf(origin);
      if (idx >= 0) list.splice(idx, 1); else list.push(origin);
      const result = await saveAllowlist(list.sort());
      return { ...result, allowlisted: idx < 0 };
    });
  }

  if (msg.type === 'removeAllowlist') {
    return enqueue(async () => {
      const origin = msg.origin;
      if (!isCanonicalOrigin(origin)) return { ok: false, error: 'Invalid origin.' };
      const list = await getAllowlist();
      const next = list.filter(value => value !== origin);
      if (next.length === list.length) return { ok: true, removed: false };
      const result = await saveAllowlist(next);
      return { ...result, removed: true };
    });
  }

  if (msg.type === 'clearAllowlist') {
    return enqueue(async () => {
      const list = await getAllowlist();
      if (!list.length) return { ok: true, cleared: 0 };
      const result = await saveAllowlist([]);
      return { ...result, cleared: list.length };
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
  try {
    const result = await applySettings(await getSettings(), persist);
    if (result.ok) await sessionSnapshot();
    return result;
  } catch (error) {
    policyStatus = { state: 'error', error: errorText(error), ruleCount: null };
    return { ok: false, error: policyStatus.error };
  }
}
// Dynamic rules survive browser restarts and extension updates. Reconcile on
// every event-page start, and migrate defaults on install/update. Never auto-enable
// a lockdown control, clear site data, unregister workers or reload user tabs.
enqueue(() => reconcile());
api.runtime.onInstalled.addListener(() => enqueue(() => reconcile(true)));
