// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LATEST RELEASE, FROM ONE PLACE (kanban #753, a tester 2026-10-28: "Link always latest release and mention the latest build
// number"). No page carries a release number. Every link to a release is https://github.com/bitcoin-arena/bitcoin-arena/releases/latest in
// the HTML; this script reads the number from the update channel the release scripts publish with every release
// (https://testnet.bitcoin-arena.io/release/latest.json, written by tools/release/latest.mjs, CORS *) and writes it where a page asks:
//
//     <span data-arena-release-version></span>          the version, as latest.json names it
//     <a data-arena-release-asset="bitcoin-arena-node-setup-{v}-windows-x64.exe" href="…/releases/latest">   the file of that release
//                                                       ({v} is the version; the href stays the releases page until it is read)
//
// Until it is read, or if it cannot be, the version spans stay empty (a page hides what depends on them with :empty) and the links keep
// pointing at the latest release on GitHub. Loaded by bitcoin-arena.io (js/release-latest.js) and the docs (from bitcoin-arena.io).
(function () {
  var CHANNEL = 'https://testnet.bitcoin-arena.io/release/latest.json';
  var REPO = 'https://github.com/bitcoin-arena/bitcoin-arena';

  /** The version of a latest.json, or null when it is not one: four or three dot-separated numbers, the tag v + version. */
  function versionOf(latest) {
    var v = latest && latest.version;
    if (typeof v !== 'string' || !/^\d{4}\.\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(v)) return null;
    if (latest.tag && latest.tag !== 'v' + v) return null;
    return v;
  }

  /** The download address of one file of release v ({v} in the name is the version). */
  function assetUrl(name, v) { return REPO + '/releases/download/v' + v + '/' + name.split('{v}').join(v); }

  /** Writes v into the page: every version span, every asset link. */
  function apply(doc, v) {
    var spans = doc.querySelectorAll('[data-arena-release-version]');
    for (var i = 0; i < spans.length; i++) spans[i].textContent = v;
    var links = doc.querySelectorAll('[data-arena-release-asset]');
    for (var j = 0; j < links.length; j++) links[j].setAttribute('href', assetUrl(links[j].getAttribute('data-arena-release-asset'), v));
  }

  async function show(doc, fetcher) {
    try {
      var r = await fetcher(CHANNEL, { cache: 'no-store' });
      if (!r.ok) return null;
      var v = versionOf(await r.json());
      if (v) apply(doc, v);
      return v;
    } catch (e) { return null; }
  }

  if (typeof window !== 'undefined') {
    window.ARENA_RELEASE_LATEST = { CHANNEL: CHANNEL, versionOf: versionOf, assetUrl: assetUrl, apply: apply, show: show };
    var go = function () { show(document, function (u, o) { return fetch(u, o); }).then(function (v) { window.ARENA_RELEASE_LATEST.last = v; }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }
})();
