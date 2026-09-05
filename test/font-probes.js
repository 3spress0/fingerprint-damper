/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Diagnostic only. Probes stay on this page: no requests, telemetry, or changes
// to document.fonts. A failed local() load can mean absent OR browser-blocked.
async function probeLocalFonts() {
  if (!window.FontFace || !document.fonts) return { supported: false };
  const missing = 'FingerprintDamperMissingFont_9f657c0182';
  const candidates = ['Arial', 'Segoe UI', 'Helvetica', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans'];
  const names = candidates.concat(missing);
  const loaded = await Promise.all(names.map(async (name, i) => {
    try {
      const face = new FontFace('FPD_probe_' + i, 'local("' + name + '")');
      await face.load();
      return true;
    } catch (_) { return false; }
  }));
  return {
    supported: true,
    missingCheck: document.fonts.check('12px "' + missing + '"'),
    // Iteration lists document-managed faces, not every installed system font.
    documentFamilies: Array.from(document.fonts, (face) => face.family),
    availableCandidates: candidates.filter((_, i) => loaded[i]),
    missingLoaded: loaded[loaded.length - 1]
  };
}
