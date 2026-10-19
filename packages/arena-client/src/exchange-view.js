// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET AS AN EXCHANGE SHOWS IT (2026-10-17: "build a real desktop view with complete order book bids ask,
// chart, depth (switchable) like an exchange. Like Polymarket is doing"; "For all prediction markets"): the page draws it for any
// market's own client (ARENA_GAME.market.exchange), from the seats' GET /book - its priced resting levels (book-ledger.js `levels`)
// and its cleared batches.
//
// One side is traded at a time ("Trade Up" / "Trade Down"), as Polymarket shows it: buying that side is a BID at its price; a buy
// of the other side at q is an ASK of this one at 1 - q (the two make one set); a resting sell of this side is an ask at its price,
// one of the other side a bid at 1 - its price. Levels are by the cent, sizes in shares (a share pays 1 sat if its side wins),
// totals in sats. The chart is the price of the side at each batch that matched; depth is the cumulative shares either way.
const XV_SCALE = 100000n, XV_TICK = 1000n;

const xvBig = (v) => { try { return BigInt(v); } catch { return 0n; } };

/** The ladder for buying `side`: { asks (lowest first), bids (highest first), bestBid, bestAsk, spread, mid } - each level
 *  { cents, shares, totalSat, cumShares }, shares and sats whole numbers. */
export function exchangeLadder(book, { side = 0 } = {}) {
  const lv = (book && book.levels) || { buys: [], sells: [] };
  const bids = new Map(), asks = new Map();
  const add = (m, price, sharesMsat) => {
    if (price <= 0n || price >= XV_SCALE || sharesMsat <= 0n) return;
    const cents = Number(price / XV_TICK);
    m.set(cents, (m.get(cents) || 0n) + sharesMsat);
  };
  for (const b of lv.buys || []) {
    const price = xvBig(b.price), net = xvBig(b.netMsat);
    if (price <= 0n) continue;
    const shares = (net * XV_SCALE) / price;
    if (Number(b.outcome) === side) add(bids, price, shares); else add(asks, XV_SCALE - price, shares);
  }
  for (const s of lv.sells || []) {
    const price = xvBig(s.price), shares = xvBig(s.sharesMsat);
    if (Number(s.outcome) === side) add(asks, price, shares); else add(bids, XV_SCALE - price, shares);
  }
  const rows = (m, desc) => {
    let cum = 0;
    return [...m.entries()].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).map(([cents, msat]) => {
      const shares = Number(msat / 1000n); cum += shares;
      return { cents, shares, totalSat: Math.round((shares * cents) / 100), cumShares: cum };
    }).filter((r) => r.shares > 0);
  };
  const a = rows(asks, false), b = rows(bids, true);
  const bestAsk = a.length ? a[0].cents : null, bestBid = b.length ? b[0].cents : null;
  return { asks: a, bids: b, bestBid, bestAsk, spread: bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null,
    mid: bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : bestAsk !== null ? bestAsk : bestBid };
}

/** The side's price at each batch that matched: [{ t (ms, the batch's cutoff), cents }], oldest first. `batchMs` the book's clock. */
export function exchangeHistory(book, { side = 0, batchMs = 500 } = {}) {
  return ((book && book.batches) || []).filter((b) => b && Array.isArray(b.fills) && b.fills.length && b.price !== undefined && b.price !== null)
    .map((b) => { const c = Number(xvBig(b.price) / XV_TICK); return { t: (Number(b.k) + 1) * batchMs, cents: side === 0 ? c : 100 - c }; })
    .sort((x, y) => x.t - y.t);
}

/** The shares matched in the book so far, in sat: what its positions hold of either side, halved (a set is one Up and one Down). */
export function exchangeVolume(book) {
  let t = 0n;
  for (const p of (book && book.positions) || []) for (const s of p.shares || []) t += xvBig(s);
  return Number(t / 2000n);
}

const XV_CSS = `
.xv { display:flex; flex-direction:column; gap:10px; min-width:0; }
.xv-card { background:var(--card,#171b24); border:1px solid var(--line,#262d3b); border-radius:14px; padding:12px 14px; min-width:0; }
.xv-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:0 0 8px; }
.xv-head h3 { margin:0; font:700 13px system-ui; color:var(--dim,#8d99a8); text-transform:uppercase; letter-spacing:.06em; }
.xv-tabs { display:inline-flex; gap:2px; padding:3px; border-radius:10px; background:#0d1014; border:1px solid var(--line,#262d3b); }
.xv-tabs button { border:0; background:none; color:var(--dim,#8d99a8); font:700 12.5px system-ui; padding:5px 11px; border-radius:7px; cursor:pointer; }
.xv-tabs button.on { background:#1f2630; color:var(--text,#e8edf3); }
.xv-canvas { width:100%; height:260px; display:block; }
.xv-note { color:var(--dim,#8d99a8); font-size:12.5px; margin-top:6px; min-height:1.2em; }
.xv-book { width:100%; border-collapse:collapse; font:13px system-ui; font-variant-numeric:tabular-nums; }
.xv-book th { color:var(--dim,#8d99a8); font:600 11.5px system-ui; text-transform:uppercase; letter-spacing:.05em; text-align:right; padding:4px 8px; }
.xv-book th:first-child, .xv-book td:first-child { text-align:left; }
.xv-book td { text-align:right; padding:4px 8px; position:relative; cursor:pointer; }
.xv-book tr.ask td:first-child { color:var(--down,#ff5a6a); font-weight:700; } .xv-book tr.bid td:first-child { color:var(--up,#2fd38a); font-weight:700; }
.xv-book tr.lvl td { background-repeat:no-repeat; }
.xv-book tr.ask td.bar { background-image:linear-gradient(90deg, rgba(255,90,106,.16), rgba(255,90,106,.16)); }
.xv-book tr.bid td.bar { background-image:linear-gradient(90deg, rgba(47,211,138,.16), rgba(47,211,138,.16)); }
.xv-book tr.lvl:hover td { background-color:rgba(255,255,255,.04); }
.xv-book tr.mid td { color:var(--dim,#8d99a8); font-size:12px; text-align:center; padding:6px; border-top:1px solid var(--line,#262d3b); border-bottom:1px solid var(--line,#262d3b); cursor:default; }
.xv-book tr.none td { color:var(--dim,#8d99a8); text-align:center; padding:10px; cursor:default; }
.xv-scroll { max-height:340px; overflow:auto; }
`;

/**
 * DRAW THE EXCHANGE into `el` (an element of a client's own document): the chart or the depth (switchable) and the order book,
 * read every `everyMs` from `fetchBook()` (the seats' /book of the market's current round, or null). `outcomes` the market's two
 * labels; `onPrice(cents, side)` when a level is tapped (a client fills its limit with it). Answers { refresh, setSide, stop, last }.
 */
export function mountExchange({ el, fetchBook, outcomes = ['Yes', 'No'], onPrice = null, everyMs = 3000, label = null, closeMs = null }) {
  const doc = el.ownerDocument, win = doc.defaultView;
  if (!doc.getElementById('xv-style')) { const st = doc.createElement('style'); st.id = 'xv-style'; st.textContent = XV_CSS; doc.head.appendChild(st); }
  const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  el.classList.add('xv');
  el.innerHTML = `<div class="xv-card"><div class="xv-head"><h3 class="xv-title">Chart</h3><span class="xv-tabs" data-k="view"><button data-v="chart" class="on">Chart</button><button data-v="depth">Depth</button></span></div>
    <canvas class="xv-canvas"></canvas><div class="xv-note"></div></div>
    <div class="xv-card"><div class="xv-head"><h3>Order book</h3><span class="xv-tabs" data-k="side"><button data-v="0" class="on">Trade ${esc(outcomes[0])}</button><button data-v="1">Trade ${esc(outcomes[1])}</button></span></div>
    <div class="xv-scroll"><table class="xv-book"><thead><tr><th>Price</th><th>Shares</th><th>Total</th></tr></thead><tbody></tbody></table></div></div>`;
  const s = { view: 'chart', side: 0, book: null, at: 0, timer: null, why: '' };
  const canvas = el.querySelector('canvas'), note = el.querySelector('.xv-note'), body = el.querySelector('tbody');
  for (const tabs of el.querySelectorAll('.xv-tabs')) tabs.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    for (const x of tabs.querySelectorAll('button')) x.classList.toggle('on', x === b);
    if (tabs.dataset.k === 'view') s.view = b.dataset.v; else s.side = Number(b.dataset.v);
    draw();
  };
  body.onclick = (e) => { const r = e.target.closest('tr.lvl'); if (r && onPrice) onPrice(Number(r.dataset.c), s.side); };

  function drawBook(ladder) {
    const max = Math.max(1, ...ladder.asks.map((r) => r.shares), ...ladder.bids.map((r) => r.shares));
    const row = (r, cls) => `<tr class="lvl ${cls}" data-c="${r.cents}"><td>${r.cents}¢</td><td class="bar" style="background-size:${Math.round((r.shares / max) * 100)}% 100%;background-position:right">${r.shares.toLocaleString('en-US')}</td><td>${r.totalSat.toLocaleString('en-US')} sats</td></tr>`;
    const asks = ladder.asks.slice(0, 12).reverse().map((r) => row(r, 'ask')).join('');
    const bids = ladder.bids.slice(0, 12).map((r) => row(r, 'bid')).join('');
    const last = exchangeHistory(s.book, { side: s.side }).slice(-1)[0];
    const mid = `<tr class="mid"><td colspan="3">${last ? `Last ${last.cents}¢` : 'No trade yet'}${ladder.spread !== null ? ` · Spread ${ladder.spread}¢` : ''}</td></tr>`;
    body.innerHTML = (asks || '<tr class="none"><td colspan="3">No asks</td></tr>') + mid + (bids || '<tr class="none"><td colspan="3">No bids</td></tr>');
  }
  function sizeCanvas() {
    const r = canvas.getBoundingClientRect(), dpr = win.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return { g, w: r.width, h: r.height };
  }
  function axes(g, w, h, pad, yTicks, yOf, fmt) {
    g.strokeStyle = 'rgba(141,153,168,.18)'; g.fillStyle = '#8d99a8'; g.font = '11px system-ui'; g.lineWidth = 1;
    for (const v of yTicks) { const y = yOf(v); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke(); g.fillText(fmt(v), w - pad.r + 6, y + 4); }
  }
  function drawChart(ladder) {
    const { g, w, h } = sizeCanvas(); g.clearRect(0, 0, w, h);
    const pad = { l: 8, r: 40, t: 10, b: 22 };
    const yOf = (c) => pad.t + (1 - c / 100) * (h - pad.t - pad.b);
    axes(g, w, h, pad, [0, 25, 50, 75, 100], yOf, (v) => v + '¢');
    const pts = exchangeHistory(s.book, { side: s.side });
    // THE AXIS RUNS TO THE MARKET'S CLOSE (measured live: from the first match to now it spanned one minute, 17:48-17:49): from
    // the first match or 5 min back, whichever is earlier, to its close when that is ahead - the line ends at now
    const now = Date.now(), close = closeMs ? Number(closeMs()) || 0 : 0;
    const t1 = close > now ? close : now;
    const t0 = Math.min(pts.length ? pts[0].t : now, now - 5 * 60000);
    const xOf = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
    g.fillStyle = '#8d99a8'; g.font = '11px system-ui';
    for (const t of [t0, (t0 + t1) / 2, t1]) { const d = new Date(t); const lbl = d.toISOString().slice(11, 16); g.fillText(lbl, Math.min(w - pad.r - 30, Math.max(pad.l, xOf(t) - 14)), h - 6); }
    const color = s.side === 0 ? '#2fd38a' : '#ff5a6a';
    if (pts.length) {
      g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
      pts.forEach((p, i) => { const x = xOf(p.t), y = yOf(p.cents); if (i) { g.lineTo(x, yOf(pts[i - 1].cents)); g.lineTo(x, y); } else g.moveTo(x, y); });
      g.lineTo(xOf(now), yOf(pts[pts.length - 1].cents)); g.stroke();
      const lastC = pts[pts.length - 1].cents; g.fillStyle = color; g.beginPath(); g.arc(xOf(now), yOf(lastC), 3.5, 0, Math.PI * 2); g.fill();
    }
    if (close > now) { g.strokeStyle = 'rgba(141,153,168,.35)'; g.setLineDash([2, 4]); g.beginPath(); g.moveTo(xOf(now), pad.t); g.lineTo(xOf(now), h - pad.b); g.stroke(); g.setLineDash([]);
    }
    if (ladder.mid !== null) { g.setLineDash([4, 4]); g.strokeStyle = 'rgba(232,237,243,.35)'; g.beginPath(); g.moveTo(pad.l, yOf(ladder.mid)); g.lineTo(w - pad.r, yOf(ladder.mid)); g.stroke(); g.setLineDash([]); }
    const vol = exchangeVolume(s.book);
    note.textContent = (pts.length ? `${outcomes[s.side]} ${pts[pts.length - 1].cents}¢ at the last match · ${pts.length} match${pts.length === 1 ? '' : 'es'}` : `No match yet in this window`)
      + (ladder.mid !== null ? ` · mid ${ladder.mid}¢` : '') + (vol ? ` · ${vol.toLocaleString('en-US')} shares matched` : '') + (s.why ? ` · ${s.why}` : '');
  }
  function drawDepth(ladder) {
    const { g, w, h } = sizeCanvas(); g.clearRect(0, 0, w, h);
    const pad = { l: 8, r: 48, t: 10, b: 22 };
    const maxQ = Math.max(1, ...ladder.bids.map((r) => r.cumShares), ...ladder.asks.map((r) => r.cumShares));
    const xOf = (c) => pad.l + (c / 100) * (w - pad.l - pad.r);
    const yOf = (q) => pad.t + (1 - q / maxQ) * (h - pad.t - pad.b);
    axes(g, w, h, pad, [0, Math.round(maxQ / 2), maxQ], yOf, (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v)));
    g.fillStyle = '#8d99a8'; g.font = '11px system-ui';
    for (const c of [0, 25, 50, 75, 100]) g.fillText(c + '¢', Math.min(w - pad.r - 20, Math.max(pad.l, xOf(c) - 8)), h - 6);
    const area = (rows, color, fill, dir) => {
      if (!rows.length) return;
      g.beginPath(); g.moveTo(xOf(rows[0].cents), yOf(0));
      let q = 0;
      for (const r of rows) { g.lineTo(xOf(r.cents), yOf(q)); q = r.cumShares; g.lineTo(xOf(r.cents), yOf(q)); }
      g.lineTo(xOf(dir < 0 ? 0 : 100), yOf(q)); g.lineTo(xOf(dir < 0 ? 0 : 100), yOf(0)); g.closePath();
      g.fillStyle = fill; g.fill(); g.strokeStyle = color; g.lineWidth = 1.5; g.stroke();
    };
    area(ladder.bids, '#2fd38a', 'rgba(47,211,138,.18)', -1);
    area(ladder.asks, '#ff5a6a', 'rgba(255,90,106,.18)', 1);
    const bid = ladder.bids.reduce((t, r) => t + r.shares, 0), ask = ladder.asks.reduce((t, r) => t + r.shares, 0);
    note.textContent = bid || ask ? `Bids ${bid.toLocaleString('en-US')} shares · asks ${ask.toLocaleString('en-US')} shares${ladder.spread !== null ? ` · spread ${ladder.spread}¢` : ''}` : 'Nothing rests in the book now';
  }
  function draw() {
    const ladder = exchangeLadder(s.book, { side: s.side });
    el.querySelector('.xv-title').textContent = s.view === 'chart' ? (label ? label(s.side) : `${outcomes[s.side]} price`) : 'Depth';
    drawBook(ladder);
    if (s.view === 'chart') drawChart(ladder); else drawDepth(ladder);
    return ladder;
  }
  async function refresh() {
    try { const b = await fetchBook(); if (b) { s.book = b; s.why = ''; } else s.why = 'no seat answered the book'; } catch (e) { s.why = 'the book could not be read'; }
    s.at = Date.now(); draw();
    return s.book;
  }
  refresh();
  s.timer = win.setInterval(refresh, everyMs);
  win.addEventListener('resize', draw);
  return { refresh, draw, setSide: (k) => { s.side = k; draw(); }, stop: () => win.clearInterval(s.timer), last: () => ({ book: s.book, side: s.side, view: s.view, ladder: exchangeLadder(s.book, { side: s.side }) }) };
}
