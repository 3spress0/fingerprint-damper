/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Shared by the diagnostic window and worker fixtures, not by the extension.
// Passive only: no requests for grants, capture, audio playback or remote data.
// Reports counts rather than raw device IDs or voice names. Results stay local.
(() => {
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, '0');
  }
  const failure = error => 'rejected: ' + (error && error.name || 'Error');
  globalThis.__fpdProbeValues = async function () {
    const nav = globalThis.navigator || {};
    const result = {
      realm: typeof document === 'undefined' ? 'worker' : 'window',
      language: nav.language || null,
      cores: nav.hardwareConcurrency || null,
      capabilities: Object.fromEntries(['OffscreenCanvas', 'FontFace', 'AudioContext', 'OfflineAudioContext',
        'SpeechSynthesis', 'MediaDevices', 'PermissionStatus'].map(name => [name, typeof globalThis[name] !== 'undefined']))
    };
    try {
      result.locale = new Intl.NumberFormat().resolvedOptions().locale;
      result.timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      result.number = (12345.67).toLocaleString();
    } catch (e) { result.locale = failure(e); }

    const samples = [
      ['acos', [.123]], ['asinh', [.123]], ['atan2', [.123, .456]], ['sin', [-1e300]],
      ['cos', [10.000000000123]], ['exp', [.123]], ['log1p', [1e-10]],
      ['pow', [Math.PI, -100]], ['sqrt', [2]], ['cbrt', [2]], ['hypot', [.123, .456]]
    ];
    result.math = hash(samples.map(([name, args]) => name + ':' + Math[name](...args).toPrecision(17)).join('|'));

    result.canvas = 'unavailable';
    result.gpu = 'unavailable';
    if (globalThis.OffscreenCanvas) {
      try {
        const canvas = new OffscreenCanvas(60, 20);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 60, 20);
        result.canvas = hash(Array.from(ctx.getImageData(0, 0, 60, 20).data).join(','));
      } catch (e) { result.canvas = failure(e); }
      try {
        const gl = new OffscreenCanvas(1, 1).getContext('webgl');
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          result.gpu = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
          const lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        }
      } catch (e) { result.gpu = failure(e); }
    }
    try {
      const fonts = globalThis.document ? document.fonts : globalThis.fonts;
      result.fontSet = fonts ? { size: fonts.size,
        missingCheck: fonts.check('12px "FingerprintDamperMissingFont_9f657c0182"') } : 'unavailable';
    } catch (e) { result.fontSet = failure(e); }

    result.voices = 'unavailable';
    if (globalThis.speechSynthesis) {
      try { result.voices = speechSynthesis.getVoices().length; } catch (e) { result.voices = failure(e); }
    }
    result.devices = 'unavailable';
    if (nav.mediaDevices && nav.mediaDevices.enumerateDevices) {
      try {
        const devices = await nav.mediaDevices.enumerateDevices();
        result.devices = { count: devices.length, kinds: {}, labelled: 0, withDeviceId: 0, withGroupId: 0 };
        for (const device of devices) {
          result.devices.kinds[device.kind] = (result.devices.kinds[device.kind] || 0) + 1;
          if (device.label) result.devices.labelled++;
          if (device.deviceId) result.devices.withDeviceId++;
          if (device.groupId) result.devices.withGroupId++;
        }
      } catch (e) { result.devices = failure(e); }
    }
    result.permissions = 'unavailable';
    if (nav.permissions && nav.permissions.query) {
      const names = ['geolocation', 'notifications', 'camera', 'microphone', 'persistent-storage',
        'midi', 'clipboard-read', 'clipboard-write'];
      result.permissions = Object.fromEntries(await Promise.all(names.map(async name => {
        try { return [name, (await nav.permissions.query({ name })).state]; }
        catch (e) { return [name, failure(e)]; }
      })));
    }
    return result;
  };
})();
