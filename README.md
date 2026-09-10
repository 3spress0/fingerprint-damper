<p align="center">
  <img src="icons/icon.svg" alt="Fingerprint Damper logo" width="80" height="80">
</p>

<h1 align="center">Fingerprint Damper</h1>

<p align="center">
  API-level fingerprint damping for Firefox.
</p>

<p align="center">
  <img alt="Firefox 142+" src="https://img.shields.io/badge/Firefox-142%2B-FF7139?logo=firefoxbrowser&logoColor=white">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-2b5fd9">
  <img alt="License GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue">
</p>

## What is it?

Fingerprint Damper reduces browser fingerprinting by changing selected JavaScript APIs that expose identifying information.

It complements network blockers such as uBlock Origin:

**Network blockers** stop requests.
**Fingerprint Damper** changes what already-loaded scripts can read.

The goal is a stable, common-looking browser profile rather than constantly changing random values.

## Protects

Default protections include:

* Canvas
* WebGL
* Hardware concurrency
* Device memory
* Battery information

Additional protections are available as optional features.

See [docs/coverage.md](docs/coverage.md) for details.

## Install

Requires **Firefox 142+**.

For development, load `manifest.json` through:

`about:debugging#/runtime/this-firefox`

A signed XPI can be installed normally.

## Test

```bash
node --test test/*.test.cjs
./package.sh --verify
```

## Limitations

Fingerprint Damper is not a complete anti-fingerprinting solution.

Page scripts can detect some protections, workers are not fully covered, and fingerprinting methods outside JavaScript API access remain out of scope.

See [docs/coverage.md](docs/coverage.md).

## Experimental

An optional global lockdown mode provides much more aggressive browser-enforced restrictions.

See [docs/lockdown.md](docs/lockdown.md).

## Privacy

No telemetry. No analytics. No remote JavaScript. No browsing data is transmitted.

## License

[GPL-3.0-or-later](LICENSE)
