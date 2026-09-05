/* Fingerprint Damper — manual HTTP lockdown fixture, not an enforcement layer.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const http = require('node:http');

const serverCSP = "script-src 'self' 'unsafe-inline'; script-src-attr 'none'; worker-src 'self' blob:; object-src 'none'";
const workerCode = `globalThis.onmessage = () => { postMessage('worker ran'); close(); };`;
const sharedCode = `globalThis.onconnect = event => {
  const port = event.ports[0];
  port.onmessage = () => { port.postMessage('worker ran'); port.close(); close(); };
  port.start();
};`;
const probeCode = `(() => {
  const say = (id, value) => { document.getElementById(id).textContent = value; };
  say('external', 'EXTERNAL SCRIPT RAN');
  document.getElementById('attribute-control').click();
  try { say('cookie', String(/(?:^|;\\s*)__fpd_lockdown_probe=1(?:;|$)/.test(document.cookie))); }
  catch (error) { say('cookie', error.name); }
  fetch('/signal?kind=fetch', { cache: 'no-store' }).then(() => say('fetch', 'Fetch returned'))
    .catch(error => say('fetch', 'Rejected/unavailable: ' + error.name));
  try { navigator.sendBeacon('/signal?kind=beacon', 'probe'); } catch (_) {}
  try {
    const url = new URL('/socket', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    socket.onerror = () => say('socket', 'Socket rejected/blocked (inspect server events)');
    socket.onopen = () => socket.close();
  } catch (error) { say('socket', 'Unavailable: ' + error.name); }
  const run = (id, create, release = () => {}) => {
    let worker, port, timer, finished = false;
    const finish = text => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (port) { port.onmessage = port.onmessageerror = null; }
      if (worker) {
        worker.onerror = null;
        if (worker.terminate) worker.terminate(); else if (port) port.close();
      }
      release(); say(id, text);
    };
    try {
      worker = create(); port = worker.port || worker;
      port.onmessage = () => finish('Worker replied');
      port.onmessageerror = () => finish('Message error');
      worker.onerror = event => { event.preventDefault(); finish('Worker error (not proof of blocking)'); };
      timer = setTimeout(() => finish('Timeout (not proof of blocking)'), 2500);
      if (port.start) port.start();
      port.postMessage('probe');
    } catch (error) { finish('Rejected/unavailable: ' + error.name); }
  };
  run('classic', () => new Worker('/worker.js'));
  run('module', () => new Worker('/module.mjs', { type: 'module' }));
  run('shared', () => new SharedWorker('/shared.js', { name: 'fpd-lockdown-test-' + Math.random() }));
  const blob = URL.createObjectURL(new Blob([${JSON.stringify(workerCode)}], { type: 'text/javascript' }));
  run('blob', () => new Worker(blob), () => URL.revokeObjectURL(blob));
})();`;
const page = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Fingerprint Damper — HTTP lockdown check</title>
<style>body{font:15px/1.5 system-ui;max-width:850px;margin:32px auto;padding:0 20px}li{margin:7px 0}code{overflow-wrap:anywhere}</style>
<link rel="stylesheet" href="/style.css">
<h1>HTTP lockdown check</h1>
<p>Use a fresh Firefox test profile. Compare extension-off baseline, each control separately,
then all controls together. Reload bypassing cache. This page does NOT emulate extension policy.</p>
<p><strong>A blank page or a failed API is not proof of protection.</strong> Check browser response
headers and the server's <a href="/events" target="_blank" rel="noopener">observed requests</a>.
The server intentionally rejects sockets even at baseline; only the server log distinguishes an attempted handshake.</p>
<ul>
<li>Inline script: <strong id="inline">DID NOT RUN</strong></li>
<li>External script: <strong id="external">DID NOT RUN</strong></li>
<li>Server CSP attribute control: <strong id="csp-control">Not evaluated (requires external script)</strong></li>
<li>Fake test cookie visible to JS: <strong id="cookie">Not read</strong></li>
<li>Fetch: <strong id="fetch">Not attempted</strong></li>
<li>Socket: <strong id="socket">Not attempted</strong></li>
<li>Classic worker: <strong id="classic">Not attempted</strong></li>
<li>Module worker: <strong id="module">Not attempted</strong></li>
<li>Shared worker: <strong id="shared">Not attempted</strong></li>
<li>Blob worker: <strong id="blob">Not attempted</strong></li>
</ul>
<button id="attribute-control" hidden onclick="document.getElementById('csp-control').textContent='SERVER CSP WAS LOST'">Attribute control</button>
<img src="/pixel.png" width="32" height="32" alt="Local image probe">
<iframe src="/frame" title="Local embed probe"></iframe>
<form action="/submitted" method="post"><button>Explicit test form submission (navigates)</button></form>
<p><a href="/prime-cookie">Set the fake local session cookie</a> (explicit action only).
No real cookie values, user-agent strings or authorization are logged. No grants/capture/playback,
service-worker registrations or worklets are requested.</p>
<script>document.getElementById('inline').textContent='INLINE SCRIPT RAN';</script>
<script src="/probe.js"></script>
<script>if(document.getElementById('external').textContent==='EXTERNAL SCRIPT RAN' &&
 document.getElementById('csp-control').textContent.indexOf('Not evaluated')===0)
 document.getElementById('csp-control').textContent='Server CSP attribute restriction intact';</script>
</html>`;

function createFixture() {
  const events = [];
  const paths = new Set(['/', '/events', '/prime-cookie', '/probe.js', '/worker.js', '/module.mjs',
    '/shared.js', '/style.css', '/pixel.png', '/frame', '/signal', '/socket', '/submitted']);
  function record(req) {
    const url = new URL(req.url, 'http://fixture.invalid');
    // Never log raw headers, query parameters, request bodies, IPs or arbitrary paths.
    const kind = url.searchParams.get('kind');
    events.push({ path: paths.has(url.pathname) ? url.pathname : 'other',
      signal: ['fetch', 'beacon'].includes(kind) ? kind : null,
      probeCookie: /(?:^|;\s*)__fpd_lockdown_probe=1(?:;|$)/.test(req.headers.cookie || ''),
      userAgentPresent: !!req.headers['user-agent'], languagePresent: !!req.headers['accept-language'],
      refererPresent: !!req.headers.referer });
    if (events.length > 256) events.shift();
    return url.pathname;
  }
  const server = http.createServer((req, res) => {
    const path = record(req);
    req.resume(); // Discard, never collect, request bodies.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', serverCSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/') return res.end(page);
    if (path === '/events') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(events, null, 2));
    }
    if (path === '/prime-cookie') {
      res.setHeader('Set-Cookie', '__fpd_lockdown_probe=1; Path=/; SameSite=Lax');
      return res.end('<p>Fake session-cookie response sent (may be stripped). <a href="/">Return to the check</a>.</p>');
    }
    if (['/probe.js', '/worker.js', '/module.mjs', '/shared.js'].includes(path)) {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(path === '/probe.js' ? probeCode : path === '/shared.js' ? sharedCode : workerCode);
    }
    if (path === '/style.css') {
      res.setHeader('Content-Type', 'text/css');
      return res.end('h1 { border-bottom: 3px solid #2b5fd9; }');
    }
    if (path === '/pixel.png') {
      res.setHeader('Content-Type', 'image/png');
      return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9xkAAAAASUVORK5CYII=', 'base64'));
    }
    if (path === '/frame') return res.end('<p>Frame loaded.</p>');
    if (path === '/submitted') return res.end('<p>Form submission reached the server.</p>');
    if (path === '/signal') { res.statusCode = 204; return res.end(); }
    res.statusCode = 404; res.end('Not found');
  });
  server.on('upgrade', (req, socket) => { record(req); socket.destroy(); });
  return server;
}
if (require.main === module) {
  const port = Number(process.env.PORT || 8765);
  const host = process.env.HOST || '127.0.0.1';
  const server = createFixture();
  server.listen(port, host, () => console.log(`Lockdown HTTP fixture listening on ${host}:${port}. No repository files are served.`));
}
module.exports = { createFixture, serverCSP, probeCode, workerCode, sharedCode, page };
