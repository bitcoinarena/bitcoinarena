// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TESTED SIGNERS AND WALLETS (kanban #2917): results.json holds one row per product and kind, written by
// packages/arena-node/tools/compat-check.mjs (by hand or by a run against the product); planned.json the products still to test.
// Only rows that WORK are listed as working; a product with problems is not shown until it is fixed and tested again.
// Two groups: Log in (browser extensions, remote signers) and Pay and withdraw (NWC wallets), then "Next to test".
(function () {
  var GROUPS = [
    { id: 'login', title: 'Log in', kinds: ['Browser extension', 'Remote signer'] },
    { id: 'pay', title: 'Pay and withdraw', kinds: ['NWC wallet'] }
  ];
  var NIP = { 'Browser extension': 'NIP-07', 'Remote signer': 'NIP-46', 'NWC wallet': 'NIP-47' };
  var CHECKED = {
    login: 'logged in to the Arena', seed: 'wallet seed sealed with NIP-44', sign: 'requests signed', decrypt: 'wallet seed decrypted with NIP-44',
    connect: 'connected', get_public_key: 'key read', 'sign_event 27235': 'requests signed (NIP-98)',
    'sign_event 30078': 'wallet seed event signed', 'nip44 to self': 'NIP-44 encryption',
    get_info: 'wallet info', get_balance: 'balance read', make_invoice: 'withdrawal invoice made', pay_invoice: 'deposit paid'
  };

  /** What was checked, in words: "By hand: logged in to the Arena." */
  function checkedLine(row) {
    var said = Object.keys(row.checks || {}).map(function (k) { return CHECKED[k] || k; });
    var how = row.how === 'manual' ? 'By hand' : 'Automatic run';
    return how + ': ' + said.join(', ') + '.';
  }

  /** The page's content: each group's working rows, then what is still to test (not already listed as working). */
  function sections(results, planned) {
    var works = (Array.isArray(results) ? results : []).filter(function (r) { return r && r.result === 'works' && Object.keys(r.checks || {}).length; });
    var groups = GROUPS.map(function (g) {
      var rows = works.filter(function (r) { return g.kinds.indexOf(r.kind) >= 0; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); })
        .map(function (r) { return { name: r.name, url: r.url || null, kind: r.kind, nip: NIP[r.kind] || '', platform: r.platform || '', version: r.version, date: r.date, checked: checkedLine(r) }; });
      return { id: g.id, title: g.title, rows: rows };
    });
    var next = (Array.isArray(planned) ? planned : []).filter(function (p) {
      return p && !works.some(function (r) { return r.name === p.name && r.kind === p.kind; });
    }).map(function (p) { return { name: p.name, url: p.url || null, kind: p.kind, nip: NIP[p.kind] || '', platform: p.platform || '' }; });
    return { groups: groups, next: next };
  }

  function el(doc, tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function nameOf(doc, r) {
    if (!r.url || !/^https:\/\//.test(r.url)) return el(doc, 'b', null, r.name);
    var a = el(doc, 'a', null, r.name); a.href = r.url; a.rel = 'noopener'; return a;
  }

  /** Draw the sections into root (#compat). */
  function draw(root, doc, data) {
    data.groups.forEach(function (g) {
      var box = root.querySelector('[data-group="' + g.id + '"]');
      if (!box) return;
      if (!g.rows.length) { box.appendChild(el(doc, 'p', 'none', 'None tested yet.')); return; }
      g.rows.forEach(function (r) {
        var card = el(doc, 'div', 'card');
        var top = el(doc, 'div', 'top'); top.appendChild(nameOf(doc, r)); top.appendChild(el(doc, 'span', 'ok', 'Works'));
        card.appendChild(top);
        card.appendChild(el(doc, 'div', 'meta', [r.kind + ' (' + r.nip + ')', r.platform, 'version ' + r.version, 'tested ' + r.date].filter(Boolean).join(' · ')));
        card.appendChild(el(doc, 'div', 'checked', r.checked));
        box.appendChild(card);
      });
    });
    var nb = root.querySelector('[data-group="next"]');
    if (nb) data.next.forEach(function (p) {
      var card = el(doc, 'div', 'card next');
      var top = el(doc, 'div', 'top'); top.appendChild(nameOf(doc, p)); top.appendChild(el(doc, 'span', 'wait', 'Not tested yet'));
      card.appendChild(top);
      card.appendChild(el(doc, 'div', 'meta', [p.kind + ' (' + p.nip + ')', p.platform].filter(Boolean).join(' · ')));
      nb.appendChild(card);
    });
  }

  function json(fetcher, u) { return fetcher(u).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }); }

  /** Load both lists and draw them. */
  function show(root, doc, fetcher) {
    return Promise.all([json(fetcher, 'results.json'), json(fetcher, 'planned.json')]).then(function (l) { var d = sections(l[0], l[1]); draw(root, doc, d); return d; });
  }

  window.ARENA_COMPAT = { sections: sections, checkedLine: checkedLine, draw: draw, show: show };
  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('compat')) show(document.getElementById('compat'), document, window.fetch.bind(window));
})();
