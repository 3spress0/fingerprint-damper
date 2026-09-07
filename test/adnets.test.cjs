/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const manifest = JSON.parse(readFileSync(join(__dirname, '../manifest.json'), 'utf8'));
const rules = JSON.parse(readFileSync(join(__dirname, '../rules/adnets.json'), 'utf8'));
const notice = readFileSync(join(__dirname, '../rules/NOTICE.md'), 'utf8');

const originalTeardownDomains = [
  '9hito.com', 'zdzhk.com', 'kbvcd.com', 'rtmark.net', 'dulotadtor.com', 'abunownon.com',
  'dawac.com', '10zon.com', 'kocmg.com', 'blxwnnw.com', 'lzrikate.com', 'pheegoab.click',
  'phenver.com', 'pushno.com'
];

const sourceSnapshotAdditions = [
  '0sywjs4r1x.com', '2iiyrxk0.com', '45eijvhgj2.com', '550b3ikb9j.com', '5nt1gx7o57.com',
  'aanqylta.com', 'abodealley.com', 'adcalm.com', 'adslop.com', 'allownotification.com',
  'allownotifications.com', 'allowpush.com', 'b42rracj.com', 'babyboomboomads.com',
  'bcloudhost.com', 'bnhtml.com', 'bnserving.com', 'btvhdscr.com', 'clicksgear.com',
  'clickterra.net', 'cpm20.com', 'cpmterra.com', 'curriculture.com', 'digiads.tv',
  'edua29146y.com', 'enyayinxiang.com', 'hibids10.com', 'hoo1luha.com', 'htmonster.com',
  'ip-51-255-80.eu', 'kiloh.ovh', 'kuuad.com', 'medyagundem.com', 'messard.com',
  'mlllllllmmm.ovh', 'mllllllmmm.ovh', 'mlllllmmmm.ovh', 'notificationallow.com',
  'o4uxrk33.com', 'oyi9f1kbaj.com', 'popadscdn.net', 'postback.info', 'producebreed.com',
  'pushmenews.com', 'pushmobilenews.com', 'q8ntfhfngm.com', 'reddleops.pro', 'see-work.info',
  'slftps.com', 'subdo.torrentlocura.com', 'ttoc8ok.com', 'twk20rw5v1.com', 'urldelivery.com',
  'ursorsee.pro', 'vidcpm.com', 'vidzi.tv', 'viperishly.com', 'webair.com', 'wellhello.com',
  'wvhba6470p.com', 'ww2.imgadult.com', 'ww2.imgtaxi.com', 'ww2.imgwallet.com', 'y1jxiqds7v.com'
];

test('manifest carries the v1.1.0 release branding', () => {
  assert.equal(manifest.version, '1.1.0');
});

test('static ad-network list has a reviewed third-party source snapshot and preserves safety exclusions', () => {
  assert.deepEqual(rules.map(rule => rule.id), [1, 2, 3, 4]);
  const teardown = rules.find(rule => rule.id === 1);
  const sourced = rules.find(rule => rule.id === 4);
  assert.deepEqual(teardown.condition.requestDomains, originalTeardownDomains);
  assert.equal(sourced.condition.domainType, 'thirdParty');
  assert.deepEqual(sourced.condition.requestDomains, sourceSnapshotAdditions);
  assert.deepEqual(sourced.condition.resourceTypes, teardown.condition.resourceTypes);

  const allDomains = [...teardown.condition.requestDomains, ...sourced.condition.requestDomains];
  const publicSourceDomains = [...sourceSnapshotAdditions,
    'lzrikate.com', 'pheegoab.click', 'phenver.com', 'pushno.com'].sort();
  assert.equal(publicSourceDomains.length, 68);
  assert.deepEqual(allDomains.filter(domain => publicSourceDomains.includes(domain)).sort(), publicSourceDomains);
  assert.equal(allDomains.length, 78);
  assert.equal(new Set(allDomains).size, allDomains.length, 'domain entries must not overlap');
  for (const domain of allDomains) {
    assert.match(domain, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, domain);
  }
  for (const backend of ['etacloud.org', 'tubeapi.org']) {
    assert.ok(!allDomains.includes(backend), `${backend} is deliberately not blocked`);
  }
});

test('source snapshot has pinned public provenance and the required MIT notice', () => {
  assert.match(notice, /df7ab3692f98ad65b59821ef557659a4ffab3edb/);
  assert.match(notice, /Copyright \(c\) 2016-2026 LanikSJ/);
  assert.match(notice, /Permission is hereby granted, free of charge/);
  for (const name of ['admaven', 'admeasures', 'hilltopads', 'kitty', 'macupload', 'popads',
    'propellerads', 'toradvertising', 'videoadex']) {
    assert.match(notice, new RegExp(`${name}-domains\\.txt`));
  }
});
