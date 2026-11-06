// THE HOMEPAGE'S LIVE PARTS (kanban #1197, Daniel 2026-11-06: the calm page with facts, a network table where "Reading the nodes…" was):
// rounds settled since launch per game and in all, the protocol reserves the nodes agree on and the federations that hold them, every node
// from its bond on Bitcoin, the latest release with its date, and the trailer played in place on a press. Every number is read live or
// carries its date; none of them shrinks when nobody plays (no "today", no "online").
import { nodesFromChain } from '/js/chain-nodes.js';
import { parseTransaction } from '/js/protocol/tx.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = (n) => (typeof n === 'bigint' ? n : Number(n)).toLocaleString('en-US');
const dateLong = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const stamp = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const short = (h, n = 8) => String(h).slice(0, n);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const getJson = async (url, ms = 15000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms), cache: 'no-store' }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
const NEEDED = 5;   // a reserve total counts only when this many nodes name the same one (as js/reserves.js on the live page)

// THE TRAILER, small and calm: a poster frame; a press puts the 60 s trailer with sound in its place
(() => {
  const btn = $('#playtrailer');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const v = document.createElement('video');
    v.src = '/media/trailer-v2.mp4'; v.controls = true; v.playsInline = true; v.autoplay = true; v.poster = '/media/poster-v2.jpg';
    v.setAttribute('aria-label', 'Bitcoin Arena trailer, 60 seconds');
    v.style.border = '1px solid var(--line)'; v.style.borderRadius = '4px'; v.style.background = '#000';
    btn.replaceWith(v);
    v.play().catch(() => {});
  });
})();

// ROUNDS SETTLED SINCE LAUNCH, per game and in all, from the explorer's store (a count that only grows)
(async () => {
  try {
    const t = await getJson('https://explorer.bitcoinarena.io/api/totals');
    for (const el of $$('[data-total]')) {
      const k = el.dataset.total;
      const g = k === 'all' ? t.all : (t.games || {})[k];
      el.textContent = g ? fmt(g.settled) : '0';
    }
    $('#entries').textContent = fmt(t.all.entries);
    if (t.since) for (const el of $$('[data-since]')) el.textContent = dateLong(t.since);
  } catch { for (const el of [...$$('[data-total]'), $('#entries')]) el.textContent = 'not read'; }
})();

// THE PROTOCOL RESERVES AND THE FEDERATIONS THAT HOLD THEM: every testnet node (the Arena page's daily.json) is asked GET /reserves; the
// total and the per-federation rows show only when at least NEEDED nodes answer the same total, so no single node sets the numbers
(async () => {
  const body = $('#feds'), note = $('#fedsnote');
  try {
    const daily = await getJson('https://testnet.bitcoinarena.io/daily.json');
    const seats = [...new Set(((daily.testnet || {}).node || []).map((n) => String(n).replace(/\/+$/, '')))];
    const answers = (await Promise.all(seats.map((b) => getJson(`${b}/reserves`, 10000).catch(() => null)))).filter(Boolean);
    const by = new Map();
    for (const a of answers) { if (!/^\d+$/.test(String(a.totalMsat))) continue; const k = String(a.totalMsat); by.set(k, [...(by.get(k) || []), a]); }
    const best = [...by.values()].sort((x, y) => y.length - x.length)[0] || [];
    const agreed = best.length >= NEEDED ? best[0] : null;
    if (!agreed) {
      $('#restotal').textContent = '–';
      $('#resline').textContent = `the nodes do not agree on a total yet (${best.length} of ${seats.length} name the same one)`;
      body.innerHTML = '<tr><td colspan="5">Shown once 5 nodes agree.</td></tr>';
      return;
    }
    const at = stamp(Date.now());
    $('#restotal').textContent = fmt(BigInt(agreed.totalMsat) / 1000n);
    $('#resline').textContent = `${fmt(agreed.entries)} payments in · ${best.length} of ${seats.length} nodes agree · read ${at}`;
    const feds = (agreed.federations || []).filter((f) => /^\d+$/.test(String(f.heldMsat)) && BigInt(f.heldMsat) > 0n)
      .sort((a, b) => (BigInt(b.heldMsat) > BigInt(a.heldMsat) ? 1 : -1));
    body.innerHTML = '';
    for (const f of feds) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td title="${esc(f.federationId)}">${esc(short(f.federationId, 12))}</td><td class="r">${(f.members || []).length || '–'}</td>`
        + `<td class="r">${esc(f.needed ?? '–')}</td><td class="r">${fmt(BigInt(f.heldMsat) / 1000n)}</td><td class="r">${fmt(f.entries || 0)}</td>`;
      body.appendChild(tr);
    }
    if (!feds.length) body.innerHTML = '<tr><td colspan="5">No federation holds protocol reserves yet.</td></tr>';
    note.textContent = `GET /reserves at ${seats.length} nodes, ${best.length} agree · read ${at}`;
  } catch (e) {
    $('#restotal').textContent = '–';
    $('#resline').textContent = 'the nodes could not be read';
    body.innerHTML = `<tr><td colspan="5">The federations could not be read (${esc(String(e.message || e).slice(0, 80))}).</td></tr>`;
  }
})();

// THE NODES, FROM BITCOIN: every bond proved into its block and its signature checked here (chain-nodes.js); the bond's sats from its own output
(async () => {
  const body = $('#nodes'), note = $('#nodesnote');
  try {
    for (let i = 0; i < 50 && !(globalThis.ARENA_CURVE && globalThis.ARENA_CURVE.verify); i++) await new Promise((r) => setTimeout(r, 100));
    const data = await getJson('/api/chain-nodes', 30000);
    const { nodes, rejected } = nodesFromChain(data, { verify: globalThis.ARENA_CURVE.verify });
    const byTxid = new Map((data.txs || []).map((t) => [t.txid, t]));
    const rows = nodes.map((n) => {
      const [txid, vout] = String(n.bond).split(':');
      const t = byTxid.get(txid);
      let sats = null;
      try { sats = parseTransaction(Uint8Array.from(t.hex.match(/../g).map((x) => parseInt(x, 16)))).outputs[Number(vout)].value; } catch { sats = null; }
      return { key: n.key, txid, vout, sats, height: t && Number.isInteger(t.height) ? t.height : null };
    }).sort((a, b) => (a.height ?? Infinity) - (b.height ?? Infinity));
    body.innerHTML = '';
    const SHOWN = 10;
    for (const [i, r] of rows.entries()) {
      const tr = document.createElement('tr');
      if (i >= SHOWN) tr.className = 'hid';
      tr.innerHTML = `<td title="${esc(r.key)}">${esc(short(r.key, 12))}</td><td class="r">${r.sats === null ? '–' : fmt(r.sats)}</td>`
        + `<td><a href="https://mempool.space/testnet4/tx/${esc(r.txid)}">${esc(short(r.txid, 12))}…:${esc(r.vout)}</a></td><td class="r">${r.height === null ? '–' : fmt(r.height)}</td>`;
      body.appendChild(tr);
    }
    if (!rows.length) body.innerHTML = '<tr><td colspan="4">No bonded node found on Bitcoin testnet4.</td></tr>';
    const more = $('#morenodes');
    if (rows.length > SHOWN) { more.hidden = false; more.textContent = `Show all ${rows.length} nodes`; more.onclick = () => { $$('#nodes tr.hid').forEach((x) => x.classList.remove('hid')); more.hidden = true; }; }
    const total = rows.reduce((s, r) => s + (r.sats === null ? 0n : BigInt(r.sats)), 0n);
    note.textContent = `${rows.length} nodes, ${fmt(total)} sats bonded · Bitcoin testnet4 read ${data.at ? stamp(data.at) : 'just now'}`
      + (Number.isInteger(data.tip) ? ` at block ${fmt(data.tip)}` : '')
      + (rejected.length ? ` · ${rejected.length} announcements not counted (spent, unproved or unsigned)` : '');
  } catch (e) { body.innerHTML = `<tr><td colspan="4">The nodes could not be read (${esc(String(e.message || e).slice(0, 80))}).</td></tr>`; }
})();

// THE LATEST RELEASE, from the update channel, with its date
(async () => {
  try {
    const l = await getJson('https://testnet.bitcoinarena.io/release/latest.json');
    if (!/^\d{4}\.\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(String(l.version))) return;
    $('#relv').textContent = l.version;
    if (/^https:\/\/github\.com\//.test(String(l.release || ''))) $('#relv').href = l.release;
    if (l.publishedMs) $('#reld').textContent = `published ${dateLong(Number(l.publishedMs))}`;
  } catch { $('#relv').textContent = 'on GitHub'; }
})();
