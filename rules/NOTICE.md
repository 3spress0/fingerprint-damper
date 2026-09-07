# Static ad-network rule sources

`adnets.json` is a reviewed, static snapshot. The extension does not download,
execute, or report to an upstream filter list at runtime.

## Snapshot provenance

Rule 1 retains the project-specific RTMark/PropellerAds targets found in the
original teardown. Rule 4 adds 64 distinct domains from the following public
LanikSJ `ubo-filters` lists, normalized from domain-only filters at upstream
revision [`df7ab3692f98ad65b59821ef557659a4ffab3edb`](https://github.com/LanikSJ/ubo-filters/commit/df7ab3692f98ad65b59821ef557659a4ffab3edb)
on 2026-09-07:

- [`admaven-domains.txt`](https://github.com/LanikSJ/ubo-filters/blob/df7ab3692f98ad65b59821ef557659a4ffab3edb/filters/admaven-domains.txt)
- [`admeasures-domains.txt`](https://github.com/LanikSJ/ubo-filters/blob/df7ab3692f98ad65b59821ef557659a4ffab3edb/filters/admeasures-domains.txt)
- [`hilltopads-domains.txt`](https://github.com/LanikSJ/ubo-filters/blob/df7ab3692f98ad65b59821ef557659a4ffab3edb/filters/hilltopads-domains.txt)
- [`kitty-domains.txt`](https://github.com/LanikSJ/ubo-filters/blob/df7ab3692f98ad65b59821ef557659a4ffab3edb/filters/kitty-domains.txt)
- [`macupload-domains.txt`](https://github.com/LanikSJ/ubo-filters/blob/df7ab3692f98ad65b59821ef557659a4ffab3edb/filters/macupload-domains.txt)
- [`popads-domains.txt`](https://github.com/LanikSJ/ubo-filters/blob/df7ab3692f98ad65b59821ef557659a4ffab3edb/filters/popads-domains.txt)
- [`propellerads-domains.txt`](https://github.com/LanikSJ/ubo-filters/blob/df7ab3692f98ad65b59821ef557659a4ffab3edb/filters/propellerads-domains.txt)
- [`toradvertising-domains.txt`](https://github.com/LanikSJ/ubo-filters/blob/df7ab3692f98ad65b59821ef557659a4ffab3edb/filters/toradvertising-domains.txt)
- [`videoadex-domains.txt`](https://github.com/LanikSJ/ubo-filters/blob/df7ab3692f98ad65b59821ef557659a4ffab3edb/filters/videoadex-domains.txt)

Those files contain 68 unique domain-only entries. Four PropellerAds entries
were already in rule 1, so rule 4 adds the other 64 and rules 1 plus 4 cover 78
unique request domains. Rule 4 is restricted to `thirdParty` requests to limit
first-party breakage; the original teardown rules keep their existing scope.

## Upstream license notice

The copied snapshot is derived from LanikSJ `ubo-filters`, licensed under MIT:

> The MIT License
>
> Copyright (c) 2016-2026 LanikSJ <http://forums.lanik.us>
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
