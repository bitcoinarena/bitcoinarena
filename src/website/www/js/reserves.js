// THE PROTOCOL RESERVES ON THE HOMEPAGE (§27A.92026-10-17: "Find a prominent place on the website under
// the USPs to show the reserves ... Under the fees"): the testnet's nodes (the Arena page's daily.json) are asked GET /reserves,
// and the total is shown only when at least NEEDED of them answer the same one - as the Arena page took it - so no single node
// can set the number. Until then the panel says it is reading the nodes; if they never agree it says so.
(function () {
  var DAILY = 'https://testnet.bitcoin-arena.io/daily.json';
  var NEEDED = 5;

  /** The total most nodes agree on: { ok, totalMsat, entries, agreeing, asked } or { ok: false, why }. */
  function agreedReserves(answers, asked, needed) {
    var by = {};
    answers.forEach(function (a) {
      if (!a || !/^\d+$/.test(String(a.totalMsat))) return;
      var k = String(a.totalMsat);
      by[k] = by[k] || { n: 0, entries: Number(a.entries) || 0 };
      by[k].n++;
    });
    var best = Object.keys(by).sort(function (x, y) { return by[y].n - by[x].n || (BigInt(y) > BigInt(x) ? 1 : -1); })[0];
    if (!best) return { ok: false, why: 'none of ' + asked + ' nodes answered', asked: asked };
    if (by[best].n < needed) return { ok: false, why: 'only ' + by[best].n + ' of ' + asked + ' nodes name the same total', asked: asked };
    return { ok: true, totalMsat: best, entries: by[best].entries, agreeing: by[best].n, asked: asked };
  }

  function sats(msat) { return (Number(BigInt(msat) / 1000n)).toLocaleString('en-US'); }

  async function show(root, fetcher) {
    var num = root.querySelector('[data-r="total"]'), line = root.querySelector('[data-r="line"]');
    var r;
    try {
      var daily = await (await fetcher(DAILY)).json();
      var nodes = Array.from(new Set(((daily.testnet || {}).node || []).map(function (n) { return String(n).replace(/\/+$/, ''); })));
      var answers = await Promise.all(nodes.map(function (b) {
        return fetcher(b + '/reserves', { signal: AbortSignal.timeout(10000) }).then(function (x) { return x.ok ? x.json() : null; }).catch(function () { return null; });
      }));
      r = agreedReserves(answers, nodes.length, NEEDED);
    } catch (e) { r = { ok: false, why: e.message }; }
    root.dataset.state = r.ok ? 'ok' : 'none';
    if (!r.ok) { num.textContent = '—'; line.textContent = 'The nodes do not agree on a total yet (' + r.why + ').'; return r; }
    num.textContent = sats(r.totalMsat);
    line.textContent = r.entries + ' payment' + (r.entries === 1 ? '' : 's') + ' in · ' + r.agreeing + ' of ' + r.asked + ' nodes agree · Bitcoin testnet4';
    return r;
  }

  if (typeof window !== 'undefined') {
    window.ARENA_HOME_RESERVES = { agreedReserves: agreedReserves, show: show };
    var root = document.getElementById('reserves');
    if (root) show(root, function (u, o) { return fetch(u, o); }).then(function (r) { window.ARENA_HOME_RESERVES.last = r; });
  }
})();
