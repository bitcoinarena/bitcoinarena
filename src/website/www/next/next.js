// THE NEW HOMEPAGE'S LIVE PARTS (kanban #1197): the trailer in place, the numbers since launch, the nodes read from Bitcoin, the federations
// as the nodes name them, the latest release, Testnet Night in the visitor's time. Every number is read live or carries its date; none of
// them shrinks when nobody plays (no "today", no "online").
import { nodesFromChain } from '/js/chain-nodes.js';
import { parseTransaction } from '/js/protocol/tx.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = (n) => Number(n).toLocaleString('en-US');
const dateLong = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const short = (h, n = 8) => String(h).slice(0, n);
const getJson = async (url, ms = 15000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms), cache: 'no-store' }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };

// 1. THE TRAILER: the muted cut loops behind the button; the full trailer plays in place with sound, and goes back on Close or at its end
(() => {
  const hero = $('#hero'), bg = $('#bgvideo'), watch = $('#watch'), close = $('#closetrailer');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { const img = document.createElement('img'); img.className = 'poster'; img.src = '/next/media/poster-v2.jpg'; img.alt = ''; hero.insertBefore(img, hero.firstChild); bg.removeAttribute('autoplay'); bg.pause(); }
  let full = null;
  const open = () => {
    if (full) return;
    full = document.createElement('video');
    full.src = '/next/media/trailer-v2.mp4'; full.controls = true; full.playsInline = true; full.autoplay = true; full.poster = '/next/media/poster-v2.jpg';
    full.setAttribute('aria-label', 'Bitcoin Arena trailer, 60 seconds');
    hero.insertBefore(full, hero.firstChild);
    bg.pause(); bg.style.display = 'none';
    hero.classList.add('full');
    full.play().catch(() => {});
    full.addEventListener('ended', shut);
  };
  const shut = () => {
    if (!full) return;
    full.pause(); full.remove(); full = null;
    hero.classList.remove('full');
    if (!reduce) { bg.style.display = ''; bg.play().catch(() => {}); }
  };
  watch.addEventListener('click', open);
  close.addEventListener('click', shut);
  bg.addEventListener('click', open);
  // THE LOOP NEVER STOPS (Daniel 2026-11-06): an iPhone pauses a muted autoplay video on its own (Low Power Mode, the page in the background,
  // a decoder stall). Whenever the loop is not playing and the visitor did not open the trailer, it is started again: on its own pause or end,
  // when the page comes back, when the hero is in view again, on a stall, and on the first touch or scroll (a gesture lets iOS play).
  const keep = () => { if (reduce || full || document.hidden) return; if (bg.ended) bg.currentTime = 0; if (bg.paused) bg.play().catch(() => {}); };
  for (const e of ['pause', 'ended', 'stalled', 'suspend']) bg.addEventListener(e, () => setTimeout(keep, 300));
  document.addEventListener('visibilitychange', keep);
  window.addEventListener('pageshow', keep);
  for (const e of ['touchstart', 'pointerdown', 'scroll', 'keydown']) window.addEventListener(e, keep, { passive: true });
  if ('IntersectionObserver' in window) new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) keep(); }).observe(bg);
  setInterval(keep, 4000);
  // a decoder that sits still while "playing": nudge it back to the start
  let lastT = -1, still = 0;
  setInterval(() => { if (reduce || full || document.hidden || bg.paused) { still = 0; return; } if (bg.currentTime === lastT) { if (++still >= 2) { still = 0; bg.load(); bg.play().catch(() => {}); } } else still = 0; lastT = bg.currentTime; }, 2500);
})();

// TESTNET NIGHT in the visitor's own time (Wednesday 18 November 2026, 20:00 CET, UTC+1 = 19:00 UTC)
(() => {
  const at = new Date('2026-11-18T19:00:00Z');
  const local = at.toLocaleString(undefined, { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  $('#nightlocal').textContent = `19:00 UTC · ${local} where you are`;
})();

// 2. AND 5. EVERY ROUND SINCE LAUNCH, per game, from the explorer's store (a count that only grows)
(async () => {
  try {
    const t = await getJson('https://explorer.bitcoinarena.io/api/totals');
    for (const el of $$('[data-total]')) {
      const k = el.dataset.total;
      const g = k === 'all' ? t.all : (t.games || {})[k];
      el.textContent = g ? fmt(g.settled) : '0';
    }
    for (const el of $$('[data-entries]')) el.textContent = fmt(t.all.entries);
    for (const el of $$('[data-since]')) el.textContent = t.since ? dateLong(t.since) : '';
  } catch { for (const el of $$('[data-total],[data-entries]')) el.textContent = 'not read'; }
})();

// 5. THE NODES, FROM BITCOIN: every bond proved into its block and its signature checked here (chain-nodes.js); the bond's sats from its own output
(async () => {
  const body = $('#nodes'), note = $('#nodesnote');
  try {
    for (let i = 0; i < 40 && !(globalThis.ARENA_CURVE && globalThis.ARENA_CURVE.verify); i++) await new Promise((r) => setTimeout(r, 100));
    const data = await getJson('/api/chain-nodes', 30000);
    const { nodes, rejected } = nodesFromChain(data, { verify: globalThis.ARENA_CURVE.verify });
    const byTxid = new Map((data.txs || []).map((t) => [t.txid, t]));
    const rows = nodes.map((n) => {
      const [txid, vout] = String(n.bond).split(':');
      let sats = null;
      try { const tx = parseTransaction(Uint8Array.from(byTxid.get(txid).hex.match(/../g).map((x) => parseInt(x, 16)))); sats = tx.outputs[Number(vout)].value; } catch { sats = null; }
      return { key: n.key, txid, vout, sats, height: n.height };
    }).sort((a, b) => (a.height || 0) - (b.height || 0));
    body.innerHTML = '';
    const SHOWN = 12;
    for (const [i, r] of rows.entries()) {
      const tr = document.createElement('tr');
      if (i >= SHOWN) tr.className = 'hid';
      tr.innerHTML = `<td>${short(r.key, 16)}</td><td class="r">${r.sats === null ? '–' : fmt(r.sats)}</td>`
        + `<td><a href="https://mempool.space/testnet4/tx/${r.txid}">${short(r.txid, 16)}:${r.vout}</a></td><td class="r">${r.height ? fmt(r.height) : '–'}</td>`;
      body.appendChild(tr);
    }
    const more = $('#morenodes');
    if (rows.length > SHOWN) { more.hidden = false; more.textContent = `Show all ${rows.length} nodes`; more.onclick = () => { $$('#nodes tr.hid').forEach((x) => x.classList.remove('hid')); more.hidden = true; }; }
    const total = rows.reduce((s, r) => s + (r.sats === null ? 0n : BigInt(r.sats)), 0n);
    note.textContent = `${rows.length} nodes, ${fmt(total)} sats bonded · read ${new Date(data.at).toISOString().slice(0, 16).replace('T', ' ')} UTC at block ${fmt(data.tip)}`
      + (rejected.length ? ` · ${rejected.length} announcements not counted` : '');
  } catch (e) { body.innerHTML = `<tr><td colspan="4">The nodes could not be read (${String(e.message || e).slice(0, 80)}).</td></tr>`; }
})();

// 5. THE FEDERATIONS, AS THE NODES NAME THEM: a reserve total shows only when at least 5 nodes answer the same one (as the homepage's reserves panel)
(async () => {
  const body = $('#feds'), note = $('#fedsnote');
  try {
    const daily = await getJson('https://testnet.bitcoinarena.io/daily.json');
    const seats = [...new Set(((daily.testnet || {}).node || []).map((n) => String(n).replace(/\/+$/, '')))];
    const answers = (await Promise.all(seats.map((b) => getJson(`${b}/reserves`, 10000).catch(() => null)))).filter(Boolean);
    const by = new Map();
    for (const a of answers) { if (!/^\d+$/.test(String(a.totalMsat))) continue; const k = String(a.totalMsat); by.set(k, [...(by.get(k) || []), a]); }
    const best = [...by.values()].sort((x, y) => y.length - x.length)[0] || [];
    const agreed = best.length >= 5 ? best[0] : null;
    const one = agreed || answers[0];
    if (!one) throw new Error('no node answered');
    body.innerHTML = '';
    for (const f of one.federations || []) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${short(f.federationId, 16)}</td><td class="r">${(f.members || []).length || '–'}</td><td class="r">${f.needed ?? '–'}</td>`;
      body.appendChild(tr);
    }
    note.textContent = agreed
      ? `${best.length} of ${seats.length} nodes agree: ${fmt(BigInt(agreed.totalMsat) / 1000n)} sats in the protocol reserves from ${fmt(agreed.entries)} payments · read ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : `The nodes do not agree on a reserve total yet (${best.length} of ${seats.length} name the same one).`;
  } catch (e) { body.innerHTML = `<tr><td colspan="3">The federations could not be read (${String(e.message || e).slice(0, 80)}).</td></tr>`; }
})();

// 5. THE LATEST RELEASE, from the update channel, with its date
(async () => {
  try {
    const l = await getJson('https://testnet.bitcoinarena.io/release/latest.json');
    if (!/^\d{4}\.\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(String(l.version))) return;
    $('#relv').textContent = l.version;
    if (l.release) $('#relv').href = l.release;
    if (l.publishedMs) $('#reld').textContent = `published ${dateLong(Number(l.publishedMs))}`;
  } catch { /* the link stays the latest release on GitHub */ }
})();
