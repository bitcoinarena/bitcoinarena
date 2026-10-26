// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EXPLORER IN REACT (kanban #624, 2026-10-24: "Is it all react?"; "Group the timings by placement, lock, attestation, settlement
// and have it collapsed by default"): the newest transactions with their filters, and one transaction as its history - the node side
// summed up, then each group of what happened (placement, lock, attestation, settlement, and the page's own steps where it handed them),
// collapsed until opened. The Worker builds what its store holds into the page (window.EXPLORER_DATA), so nothing waits on a node.
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

const kept = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full: not kept */ } };
const sat = (msat) => (msat === null || msat === undefined ? '–' : (Number(msat) / 1000).toLocaleString('en-US') + ' sat');
const utc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
export const appName = (a) => ({ 'btc-updown-15m': 'Bitcoin Up or Down', nextblock: 'Tick Tock, Next Block', 'rock-paper-scissors': 'Rock Paper Scissors', '-': 'unknown' })[a] || a || 'unknown';
// EVERY KIND OF PAYMENT (kanban #683, 2026-10-26: "I don't see item purchases in the explorer"; #682: a gift "doesn't show in the explorer")
export const KINDS = { order: 'Order', item: 'Item bought', donation: 'Donation', zap: 'Zap' };
const kindOf = (t) => t.kind || 'order';
/** A row's app as said: an order's or item's game; a donation to the protocol developers alone has none. */
export const rowApp = (t) => (t.app ? appName(t.app) : kindOf(t) === 'donation' ? 'Protocol' : kindOf(t) === 'zap' ? '–' : appName('-'));
const given = typeof window !== 'undefined' ? window.EXPLORER_DATA || {} : {};

// THE RESULT (2026-10-24: "Also show the result of the transaction, if won or lost and how much it has won")
const sats = (msat) => (Number(msat) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
const signed = (msat) => (BigInt(msat) >= 0n ? '+' : '−') + sats(String(BigInt(msat) < 0n ? -BigInt(msat) : BigInt(msat))) + ' sat';
// AN ATTESTED OUTCOME BEFORE THE SETTLEMENT (kanban #629, 2026-10-24: the Up/Down card said lost at the outcome, this page said pending until
// the settlement after the objection window): the outcome and the order's side are said with it
const OUTCOMES = { 'btc-updown-15m': ['Up', 'Down'] };
export function pendingText(tx) {
  const p = tx.processed, o = p && (p.outcomes || [])[0], e = tx.entry || {};
  if (!o || o.outcome === null || o.outcome === undefined) return 'Pending';
  const names = OUTCOMES[e.app] || null, name = (i) => (names && names[i] !== undefined ? names[i] : 'outcome ' + i);
  const side = e.pick !== null && e.pick !== undefined ? name(Number(e.pick)) : null;
  const verdict = side === null ? '' : Number(e.pick) === Number(o.outcome) ? ' · your side ' + side + ' won' : ' · your side ' + side + ' lost';
  return name(Number(o.outcome)) + ' won' + verdict + ' (attested ' + new Date(Date.parse(o.receivedAt)).toISOString().slice(11, 19) + ' UTC) · settlement pending';
}
export function resultText(r) {
  if (!r) return '';
  if (r.state === 'won') return `Won ${sats(r.payoutMsat)} sat (${signed(r.netMsat)})`;
  if (r.state === 'lost') return `Lost (${signed(r.netMsat)})`;
  if (r.state === 'refunded') return 'Refunded';
  // kanban #629: an order that never filled is neither won nor lost - its stake comes back whole
  if (r.state === 'unfilled') return r.why && r.why.startsWith('cancelled') ? 'Cancelled · stake back' : 'Not filled · stake back';
  return 'Pending';
}
const resultCls = (r) => (r && r.state === 'won' ? 'ok' : r && r.state === 'lost' ? 'bad' : 'dim');

// ---- the list --------------------------------------------------------------------------------------------------------------------------
// A PAGE AT A TIME, FILTERED IN THE STORE (kanban #683, 2026-10-26: "I don't see other apps in the explorer. Add paging to the explorer to
// display more than a 1000"): the Worker answers the page the filters and the cursor ask for - newest first, Older and Newer from a row -
// and every app, kind and federation it holds with its count, so an app below the newest rows is one choice away
const FILTER_KEYS = ['app', 'kind', 'fed', 'since', 'q'];
const PAGE_KEYS = ['before', 'after'];
const PERIODS = [['', 'Any time'], ['900', 'Last 15 min'], ['3600', 'Last hour'], ['86400', 'Last 24 h'], ['604800', 'Last 7 days']];
const paramsOf = (search) => { const u = new URLSearchParams(search); return Object.fromEntries([...FILTER_KEYS, ...PAGE_KEYS].map((k) => [k, u.get(k) || ''])); };
const queryOf = (p) => { const u = new URLSearchParams(); for (const k of [...FILTER_KEYS, ...PAGE_KEYS]) if (p[k]) u.set(k, p[k]); return u.toString(); };
/** What the Worker built in or answered, as a page: { txs, older, newer, total, facets } (an array: the Worker before pages). */
export const pageOf = (r) => (Array.isArray(r) ? { txs: r, older: null, newer: null, total: r.length, facets: null } : r && Array.isArray(r.txs) ? r : null);
const count = (n) => Number(n).toLocaleString('en-US');

export function List({ data = null }) {
  const [page, setPage] = useState(pageOf(data) || pageOf(given.recent) || pageOf(kept('explorer.recent')) || { txs: [], older: null, newer: null, total: null, facets: null });
  const [p, setP] = useState(typeof location !== 'undefined' ? paramsOf(location.search) : paramsOf(''));
  const [q, setQ] = useState(p.q);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const load = (next, how) => {
    const qs = queryOf(next);
    if (how === 'push') history.pushState(null, '', '/' + (qs ? '?' + qs : '')); else if (how === 'replace') history.replaceState(null, '', '/' + (qs ? '?' + qs : ''));
    setP(next); setBusy(true);
    return fetch('/api/recent' + (qs ? '?' + qs : '')).then((r) => r.json()).then((r) => {
      setPage(pageOf(r)); setErr(null); if (!qs) keep('explorer.recent', r);
      // Newer up to the newest: that is the first page, its address without a cursor
      if (next.after && !r.newer) { const top = { ...next, after: '' }; setP(top); const t = queryOf(top); history.replaceState(null, '', '/' + (t ? '?' + t : '')); } },
      (e) => setErr(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => {
    if (!data && !pageOf(given.recent)) load(p, null); else if (!data && !queryOf(p)) keep('explorer.recent', given.recent);
    const back = () => { const n = paramsOf(location.search); setQ(n.q); load(n, null); };
    addEventListener('popstate', back);
    return () => removeEventListener('popstate', back);
  }, []);
  // a filter starts again at the newest; the id box once typing stops
  const set = (k, v) => load({ ...p, [k]: v, before: '', after: '' }, 'replace');
  useEffect(() => { if (q === p.q) return undefined; const t = setTimeout(() => set('q', q), 350); return () => clearTimeout(t); }, [q]);
  const txs = page.txs;
  const f = page.facets;
  const apps = f ? f.apps.map((x) => [x.app, x.n]) : [...new Set(txs.map((t) => t.app || '-'))].sort().map((a) => [a, null]);
  const kinds = f ? f.kinds.map((x) => [x.kind, x.n]) : [];
  const feds = f ? f.feds.map((x) => [x.federation, x.n]) : [...new Set(txs.map((t) => t.federation).filter(Boolean))].sort().map((x) => [x, null]);
  const n = (c) => (c === null ? '' : ' (' + count(c) + ')');
  if (err && !txs.length) return <p className="bad">Could not load: {err}</p>;
  const pager = (<div className="pager">
    <button type="button" disabled={!page.newer || busy} onClick={() => load({ ...p, before: '', after: '' }, 'push')}>Newest</button>
    <button type="button" disabled={!page.newer || busy} onClick={() => load({ ...p, before: '', after: page.newer }, 'push')}>Newer</button>
    <button type="button" disabled={!page.older || busy} onClick={() => load({ ...p, before: page.older, after: '' }, 'push')}>Older</button></div>);
  return (<>
    <h1>Latest transactions</h1><p className="dim">Orders, items bought, donations and zaps stored by the nodes. Updated every minute.</p>
    <div className="filters">
      <select value={p.app} onChange={(e) => set('app', e.target.value)}><option value="">All apps</option>
        {apps.map(([a, c]) => <option key={a} value={a}>{a === '-' ? 'No app' : appName(a)}{n(c)}</option>)}</select>
      <select value={p.kind} onChange={(e) => set('kind', e.target.value)}><option value="">All kinds</option>
        {(kinds.length ? kinds : Object.keys(KINDS).map((k) => [k, null])).map(([k, c]) => <option key={k} value={k}>{KINDS[k] || k}{n(c)}</option>)}</select>
      <select value={p.fed} onChange={(e) => set('fed', e.target.value)}><option value="">All federations</option>
        {feds.map(([x, c]) => <option key={x} value={x}>Federation {x.slice(0, 8)}{n(c)}</option>)}</select>
      <select value={p.since} onChange={(e) => set('since', e.target.value)}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <input placeholder="part of an id or round" value={q} onChange={(e) => setQ(e.target.value.trim().toLowerCase())} autoComplete="off" />
      <span className="dim">{busy ? 'Loading…' : count(txs.length) + (page.total !== null && page.total !== undefined ? ' of ' + count(page.total) : '')}</span>
    </div>
    <div className="card"><table className="rows"><thead><tr><th>Transaction</th><th>App</th><th>Kind</th><th className="n">Amount</th><th>Result</th><th>Federation</th><th>Round</th><th>Stored</th></tr></thead><tbody>
      {txs.map((t) => (<tr key={t.id}><td className="mono"><a href={'/tx/' + t.id}>{t.id.slice(0, 16)}…</a></td><td>{rowApp(t)}</td>
        <td className="nw">{KINDS[kindOf(t)] || kindOf(t)}{kindOf(t) === 'item' && t.item ? <span className="dim"> · {t.item.slice(t.item.lastIndexOf(' · ') + 3)}</span> : null}</td>
        <td className="n nw">{t.stakeMsat !== null && t.stakeMsat !== undefined ? (Number(t.stakeMsat) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' sat' : '–'}</td>
        <td className={'nw ' + resultCls(t.result)}>{t.result ? (t.result.state === 'won' || t.result.state === 'lost' ? signed(t.result.netMsat) : resultText(t.result)) : kindOf(t) === 'order' ? '–' : 'Paid'}</td>
        <td className="mono">{t.federation ? t.federation.slice(0, 8) : '–'}</td><td className="mono">{String(t.round || '').slice(0, 12)}</td>
        <td>{utc(t.storedMs).slice(0, 19)} UTC <span className="dim">{ago(t.storedMs)}</span></td></tr>))}
      {!txs.length ? <tr><td colSpan={8} className="dim">No matches.</td></tr> : null}</tbody></table></div>
    {page.older || page.newer ? pager : null}
  </>);
}

// ---- a gift, a zap, an item bought ---------------------------------------------------------------------------------------------------------
// (kanban #683, #682): what it paid for, from whom, its federation transaction and each output, and which nodes keep it
export function Payment({ tx }) {
  const x = tx.payment || {}, k = tx.kind;
  const known = (tx.seats || []).filter((s) => s.known).length;
  const title = k === 'item' ? 'Item bought' : k === 'zap' ? 'Zap' : 'Donation';
  const to = k === 'zap' ? 'the player' : x.target === 3 ? `protocol and ${appName(x.gameName)} developers, half each` : x.gameName ? `${appName(x.gameName)} developers` : 'protocol developers';
  return (<>
    <h1>{title}</h1><p className="mono">{tx.id}</p>
    <div className="card"><dl>
      <dt>App</dt><dd>{rowApp({ ...tx.entry, kind: k })}</dd>
      {k === 'item' ? <><dt>Item</dt><dd>{x.itemId} <span className="dim">· price {count(x.priceSat)} sat</span></dd></> : <><dt>To</dt><dd>{to}{k === 'zap' && x.gameDev ? <span className="mono dim"> · {x.gameDev}</span> : null}</dd></>}
      {x.origin ? <><dt>Given on</dt><dd>{x.origin === 'site' ? 'the site' : x.origin.startsWith('app:') ? appName(x.origin.slice(4)) : x.origin}</dd></> : null}
      <dt>Amount</dt><dd>{sat(tx.amountMsat)}</dd>
      <dt>{k === 'item' ? 'Buyer' : 'From'}</dt><dd className="mono">{(k === 'item' ? x.player : x.donor) || '–'}</dd>
      <dt>Federation</dt><dd className="mono">{x.federation || '–'}</dd>
      <dt>Federation transaction</dt><dd className="mono">{x.txid || '–'}</dd>
      <dt>Made</dt><dd>{Number.isFinite(Number(x.atMs)) ? utc(Number(x.atMs)) + ' UTC' : '–'}</dd>
      <dt>Stored</dt><dd>{tx.storedFirst ? utc(Date.parse(tx.storedFirst)) + ' UTC' : '–'}</dd>
      <dt>Nodes</dt><dd>{known} of {(tx.seats || []).length}</dd></dl></div>
    <h2>Outputs</h2>
    <div className="card"><table className="rows"><thead><tr><th>#</th><th>Paid to</th><th className="n">Amount</th></tr></thead><tbody>
      {(x.outputs || []).map((o) => <tr key={o.outIdx}><td>{o.outIdx}</td><td className="mono">{o.pk}{o.reserve ? <span className="dim"> · protocol reserve</span> : null}</td>
        <td className="n nw">{sat(o.msat)}</td></tr>)}</tbody></table></div>
    <details className="grp"><summary><b>Nodes</b> <span className="dim">{known} of {(tx.seats || []).length}</span></summary>
      <table className="rows"><thead><tr><th>Node</th><th>Has it</th><th>Stored</th></tr></thead><tbody>{(tx.seats || []).map((s) => (<tr key={s.seat}><td>{s.seat}</td>
        <td className={s.known ? 'ok' : 'dim'}>{s.known ? 'yes' : s.status ? 'no' : 'offline'}</td><td>{s.storedAt ? utc(Date.parse(s.storedAt)).slice(0, 19) + ' UTC' : '–'}</td></tr>))}</tbody></table></details>
  </>);
}

// ---- one transaction -------------------------------------------------------------------------------------------------------------------
// THE WORDS (2026-10-24: "Review all strings and make them less ai like"): a node door, a settlement step, a UI step - short
const DOORS = { handout: 'Stake shares received', entry: 'Order received', lock: 'Stake lock received', 'fee-lock': 'Fee lock received' };
const SETTLE_WORDS = [[/^committed to the settlement/, 'Nonce committed'], [/^gave its signature share/, 'Signature share sent'],
  [/^combined and submitted the settlement: ?(.*)/, (m) => 'Settlement submitted' + (m[1] ? ' · ' + m[1].toLowerCase() : '')],
  [/^took the combined signature/, 'Signature received'], [/^saw the settlement accepted/, 'Settlement confirmed']];
function settleWord(what) {
  for (const [re, w] of SETTLE_WORDS) { const m = re.exec(String(what)); if (m) return typeof w === 'function' ? w(m) : w + (/\(federation/.test(what) ? ' · ' + what.slice(what.indexOf('(federation') + 1, -1) : ''); }
  return what;
}
const UI_WORDS = { fetchDonationSet: 'Donation set loaded', fetchFees: 'Fees loaded', clientSettlementSignerNodes: 'Committee checked',
  postHandout: 'Stake shares sent', 'claim key': 'Claim key derived', deposit: 'Wallet balance checked', 'succession and merge': 'Succession and merge checked',
  exchange: 'Exchange checked', 'spendable check': 'Spendable balance checked', 'early deposit': 'Deposit checked',
  succession: 'Federation succession checked', 'succession (beside the order)': 'Federation succession checked (beside the order)', merge: 'Merge checked' };
const uiWord = (name) => UI_WORDS[name] || (/^merge /.test(name) ? 'Merge: ' + name.slice(6) : name);
/** The UI's steps as rows: "-> x" and "<- x" one row each x with how long it took, the rest as they are. */
function uiSteps(steps) {
  const out = [], open = new Map();
  for (const x of steps) {
    const m = /^(->|<-)\s*(.+?)(?:\s*\((.*)\))?$/.exec(String(x.step));
    if (m && m[1] === '->') { open.set(m[2], x.ms); continue; }
    if (m && m[1] === '<-' && open.has(m[2])) { out.push({ at: open.get(m[2]), took: x.ms - open.get(m[2]), what: uiWord(m[2]), detail: m[3] || '' }); open.delete(m[2]); continue; }
    const name = m ? m[2] : String(x.step);
    out.push({ at: x.ms, what: uiWord(name), detail: m && m[3] ? m[3] : '' });
  }
  for (const [name, at] of open) out.push({ at, what: uiWord(name) + ' (no end)' });
  return out.sort((a, b) => a.at - b.at);
}

// EVERY EVENT OF IT ON ONE CLOCK, each in its group: every node's own record (its doors with their steps, when it stored the entry,
// verified each lock, took the order into its book, what it did to settle the round), the result's attestation, and the page's steps
export function timelineOf(tx) {
  const ev = [];
  const add = (atMs, group, where, what, extra = {}) => { if (Number.isFinite(atMs)) ev.push({ atMs, group, where, what, ...extra }); };
  for (const s of tx.seats || []) {
    for (const d of s.steps || []) {
      // a node that holds no entry of it (not seated for its round) answers its lock doors 404: said as such, kept out of the summary
      const away = !s.known && d.status === 404;
      const group = d.door === 'lock' || d.door === 'fee-lock' ? 'lock' : 'placement';
      add(d.atMs, group, s.seat, (DOORS[d.door] || d.door) + (away ? ' · not in this round (404)' : ''),
        { took: away ? null : d.ms, detail: away ? '' : (d.steps || []).map((x) => x.step + ' ' + x.ms).join(', '), bad: !away && !(d.status >= 200 && d.status < 300), status: d.status, kind: away ? 'away' : 'door', away });
    }
    if (s.storedAt) add(Date.parse(s.storedAt), 'placement', s.seat, 'Order stored', { kind: 'stored' });
    if (s.book && s.book.receivedAt) add(Date.parse(s.book.receivedAt), 'placement', s.seat, 'Added to order book' + (s.book.batch ? ' · batch ' + s.book.batch : ''), { kind: 'book' });
    for (const k of ['stake', 'fee']) { const l = s.locks && s.locks[k]; if (l && l.verifiedAt) add(Date.parse(l.verifiedAt), 'lock', s.seat, (k === 'stake' ? 'Stake' : 'Fee') + ' lock verified', { detail: l.outpoint || '', kind: k + 'lock' }); }
    for (const d of s.did || []) add(d.atMs, 'settlement', s.seat, settleWord(d.what), { detail: d.detail || '', kind: 'settle' });
  }
  const p = tx.processed;
  if (p) {
    for (const o of p.outcomes || []) {
      add(Date.parse(o.observedAt), 'attestation', 'attestors', 'Result observed: ' + (o.value !== null ? o.value : 'outcome ' + o.outcome), { kind: 'outcome' });
      add(Date.parse(o.receivedAt), 'attestation', 'nodes', 'Attestation received', { detail: (o.attestors || []).map((k) => (p.names && p.names[k]) || k.slice(0, 12)).join(', '), kind: 'outcome' });
    }
    if (p.settledAt) add(Date.parse(p.settledAt), 'settlement', 'nodes', 'Settled' + (tx.settlement ? ' · ' + tx.settlement.state.toLowerCase() : ''), { detail: tx.settlement ? tx.settlement.txid : '', kind: 'settle' });
  }
  const c = tx.client, press = c && c.pressedAt ? Date.parse(c.pressedAt) : null;
  if (press) {
    add(press, 'page', 'UI', 'Order button clicked', { kind: 'page' });
    for (const x of uiSteps(c.steps || [])) add(press + x.at, 'page', 'UI', x.what, { took: x.took, detail: x.detail || '', kind: 'page' });
    for (const [k, v] of [['Submitted', c.submittedMs], ['Placed', c.placedMs], ['Lock accepted', c.lockMs]]) if (Number.isFinite(v)) add(press + v, 'page', 'UI', k, { kind: 'page' });
  }
  return ev.sort((a, b) => a.atMs - b.atMs || (a.where < b.where ? -1 : 1));
}

const GROUPS = [['page', 'Frontend (UI)'], ['placement', 'Placement'], ['lock', 'Lock'], ['attestation', 'Attestation'], ['settlement', 'Settlement']];

function Group({ id, title, events, rel }) {
  const real = events.filter((x) => !x.away);
  const nodes = new Set(real.filter((x) => x.group !== 'page').map((x) => x.where)).size;
  const span = real.length ? `${rel(real[0].atMs)} → ${rel(real[real.length - 1].atMs)}` : '';
  return (
    <details className="grp" id={id} open={typeof location !== 'undefined' && location.hash === '#' + id}>
      <summary><b>{title}</b> <span className="dim">{events.length ? `${span} · ${events.length} events${nodes ? ' · ' + nodes + ' nodes' : ''}` : 'none yet'}</span>
        </summary>
      {events.length ? (<table className="rows"><thead><tr><th>Time (UTC)</th><th>+</th><th>Where</th><th>Event</th><th>Took</th><th>Detail</th></tr></thead><tbody>
        {events.map((x, i) => (<tr key={i} className={x.away ? 'away' : x.group === 'page' ? 'pg' : ''}><td className="mono nw"><span className="day">{utc(x.atMs).slice(0, 11)}</span>{utc(x.atMs).slice(11)}</td>
          <td className={'nw' + (rel.ms(x.atMs) > 3000 ? ' slow' : '')}>{rel(x.atMs)}</td><td className="nw">{x.where}</td>
          <td>{x.what}{x.bad ? <span className="bad"> {x.status}</span> : null}</td><td className="nw">{Number.isFinite(x.took) ? x.took + ' ms' : ''}</td>
          <td className="dim mono">{x.detail || ''}</td></tr>))}</tbody></table>) : <p className="dim">None yet.</p>}
    </details>);
}

function Processed({ tx }) {
  const p = tx.processed; if (!p) return null;
  const nm = (k) => (p.names && p.names[k] ? p.names[k] : String(k).slice(0, 12) + '…');
  const list = (ks) => (ks && ks.length ? ks.map((k, i) => <span key={k}>{i ? ', ' : ''}{k === p.asker ? <b>{nm(k)} (asker)</b> : nm(k)}</span>) : <span className="dim">–</span>);
  return (<details className="grp"><summary><b>Round processing</b></summary>
    <dl>
      <dt>Game nodes</dt><dd>{list(p.game)}</dd><dt>Settlement nodes</dt><dd>{list(p.settlement)}</dd>
      <dt>Submits settlement</dt><dd>{p.asker ? nm(p.asker) : '–'}</dd>
      {p.drawnAttestors ? <><dt>Drawn attestors</dt><dd>{p.drawnAttestors.keys ? <>{p.drawnAttestors.keys.map((k, i) => {
        const signed = (p.outcomes || []).some((o) => (o.attestors || []).includes(k));
        return <span key={k}>{i ? ', ' : ''}{signed ? <b>{nm(k)} ✓</b> : nm(k)}</span>; })} <span className="dim">· {p.drawnAttestors.needed} of {p.drawnAttestors.keys.length} decide, drawn for this round</span></> : <span className="dim">{p.drawnAttestors.why || 'not known at this node'}</span>}</dd></> : null}
      <dt>Attestors</dt><dd>{(p.outcomes || []).length ? p.outcomes.map((o, i) => <div key={i}>{(o.attestors || []).map(nm).join(', ') || '–'} <span className="dim">· {utc(Date.parse(o.observedAt)).slice(0, 19)} UTC</span></div>) : <span className="dim">not yet</span>}</dd>
      <dt>Settled</dt><dd>{p.settledAt ? <>{utc(Date.parse(p.settledAt)).slice(0, 19)} UTC {p.settlementWhy ? <span className="dim">· {p.settlementWhy}</span> : null}</> : <span className="dim">not yet</span>}</dd>
    </dl></details>);
}

function Tx({ id }) {
  const [tx, setTx] = useState(given.tx && given.tx.found ? given.tx : kept('explorer.tx.' + id));
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (given.tx && given.tx.found) return;   // built into the page from the store: nothing fetched
    fetch('/api/tx/' + id).then(async (r) => { const j = await r.json(); if (j.found) { setTx(j); keep('explorer.tx.' + id, j); } else if (r.status === 404) setMissing(true); }, (e) => setErr(e.message));
  }, [id]);
  // #settlement, #lock, ... (a link from the UI's history): that group opened and in view
  useEffect(() => { const h = location.hash.slice(1); const el = h && document.getElementById(h); if (el) { el.open = true; el.scrollIntoView(); } }, [tx && tx.id]);
  if (!tx) return missing ? <><h1>Not found</h1><p className="dim">Transaction {id} is unknown.</p></> : err ? <p className="bad">Could not load: {err}</p> : <p className="dim">Loading…</p>;
  if (tx.kind && tx.kind !== 'order') return <Payment tx={tx} />;
  const e = tx.entry || {};
  const ev = timelineOf(tx);
  const nodeEv = ev.filter((x) => x.group !== 'page' && !x.away);
  // THE ORDER'S START: the press where the page handed it, else the first node it reached - so nothing is before it (2026-10-24:
  // "Negative timings": the page's steps come before the first node)
  const press = ev.find((x) => x.group === 'page');
  const t0 = press ? press.atMs : nodeEv.length ? nodeEv[0].atMs : ev.length ? ev[0].atMs : Date.now();
  // over 120 s as minutes and seconds (kanban #680: "display it as 3m 2s instead of 850s")
  const rel = (ms) => { const d = (ms - t0) / 1000, a = Math.abs(d), s = Math.round(a);
    return (d < 0 ? '−' : '+') + (a > 120 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : a.toFixed(2) + ' s'); };
  rel.ms = (ms) => ms - t0;
  // THE NODE SIDE, SUMMED UP: for each step the first node's, the half-way node's and the last node's time from the first node it reached
  const steps = [['door', 'Received'], ['stored', 'Stored'], ['stakelock', 'Stake lock verified'], ['feelock', 'Fee lock verified'], ['book', 'In order book'], ['settle', 'Settlement']]
    .map(([kind, label]) => {
      const per = new Map(); for (const x of nodeEv) if (x.kind === kind && !per.has(x.where)) per.set(x.where, x.atMs);
      const t = [...per.values()].sort((a, b) => a - b);
      return t.length ? { label, first: t[0], half: t[Math.floor(t.length / 2)], last: t[t.length - 1], n: t.length } : null;
    }).filter(Boolean);
  const known = (tx.seats || []).filter((s) => s.known).length;
  return (<>
    <h1>Transaction</h1><p className="mono">{tx.id}</p>
    <div className="card"><dl>
      <dt>App</dt><dd>{appName(e.app || e.gameId)}</dd><dt>Round</dt><dd className="mono">{e.round || '–'}</dd><dt>Federation</dt><dd className="mono">{e.federation || '–'}</dd>
      <dt>Stake</dt><dd>{sat(e.stakeMsat)}{e.limitPrice !== null && e.limitPrice !== undefined ? ' · at most ' + Math.round(Number(e.limitPrice) / 1000) + '¢' : ''}{e.pick !== null && e.pick !== undefined ? ' · pick ' + e.pick : ''}</dd>
      <dt>Fee</dt><dd>{sat(e.feeMsat)}</dd><dt>Player</dt><dd className="mono">{e.player || '–'}</dd>
      <dt>Stake lock</dt><dd className="mono">{tx.locks && tx.locks.stake ? tx.locks.stake.outpoint : e.stakeLockOutpoint || '–'}</dd>
      <dt>Fee lock</dt><dd className="mono">{tx.locks && tx.locks.fee ? tx.locks.fee.outpoint : e.feeLockOutpoint || '–'}</dd>
      <dt>Result</dt><dd className={resultCls(tx.result)}><b>{tx.result ? (tx.result.state === 'pending' ? pendingText(tx) : resultText(tx.result)) : '–'}</b>{tx.result && tx.result.sharedBy > 1 ? <span className="dim"> · paid to the player key across {tx.result.sharedBy} orders in this round</span> : null}</dd>
      <dt>Settlement</dt><dd className="mono">{tx.settlement ? tx.settlement.state + ' · ' + tx.settlement.txid : <span className="dim">not yet</span>}</dd>
      <dt>Start</dt><dd>{utc(t0)} UTC <span className="dim">{press ? '(order click)' : '(first node)'}</span></dd>
      <dt>Nodes</dt><dd>{known} of {(tx.seats || []).length}</dd></dl></div>
    <h2>Node timing <span className="dim">from {press ? 'order click' : 'first node'}</span></h2>
    <div className="card">{steps.length ? (<table className="rows"><thead><tr><th>Step</th><th>First</th><th>Median</th><th>Last</th><th>Nodes</th></tr></thead><tbody>
      {steps.map((s) => <tr key={s.label}><td>{s.label}</td><td className="nw">{rel(s.first)}</td><td className="nw">{rel(s.half)}</td><td className="nw">{rel(s.last)}</td><td className="dim nw">{s.n}</td></tr>)}</tbody></table>)
      : <p className="dim">No node timing recorded.</p>}</div>
    <h2>Timeline</h2>
    {GROUPS.filter(([g]) => g !== 'page' || tx.client).map(([g, title]) => <Group key={g} id={g} title={title} events={ev.filter((x) => x.group === g)} rel={rel} />)}
    <Processed tx={tx} />
    <details className="grp"><summary><b>Nodes</b> <span className="dim">{known} of {(tx.seats || []).length}</span></summary>
      <table className="rows"><thead><tr><th>Node</th><th>Has it</th><th>Stored</th><th>Book</th></tr></thead><tbody>{(tx.seats || []).map((s) => (<tr key={s.seat}><td>{s.seat}</td>
        <td className={s.known ? 'ok' : 'dim'}>{s.known ? 'yes' : s.status ? 'no' : 'offline'}</td><td>{s.storedAt ? rel(Date.parse(s.storedAt)) : '–'}</td>
        <td className="dim">{s.book ? 'batch ' + (s.book.batch || '–') : ''}</td></tr>))}</tbody></table></details>
  </>);
}

// ---- the metrics --------------------------------------------------------------------------------------------------------------------------
// THE METRICS PAGE (kanban #676, 2026-10-25: "Explorer also shows volume in Sats / btc per day, current protocol reserve in sats / btc, and
// total referrer fees accumulated in sats / btc. Moves to btc when it's over 1 million Satoshi", "This is On a metrics page")
/** An amount as people read it: sats below 1,000,000 sat, BTC from there on. */
export function amount(msat) {
  if (msat === null || msat === undefined) return '–';
  const s = BigInt(msat) / 1000n;
  if (s < 1000000n) return Number(s).toLocaleString('en-US') + ' sat';
  return (Number(s) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' BTC';
}
export function Metrics({ data = null }) {
  const [m, setM] = useState(data || given.metrics || null);
  const [err, setErr] = useState(null);
  useEffect(() => { if (data || given.metrics) return; fetch('/api/metrics').then((r) => r.json()).then(setM, (e) => setErr(e.message)); }, []);
  if (!m) return <p className="dim">{err ? 'Could not read the metrics: ' + err : 'Reading …'}</p>;
  const most = (m.volume || []).reduce((t, d) => (BigInt(d.msat) > t ? BigInt(d.msat) : t), 1n);
  return (<>
    <h1>Metrics</h1>
    <div className="stats">
      <div className="card stat"><span>Volume today</span><b>{amount(m.volume && m.volume[0] && m.volume[0].day === new Date().toISOString().slice(0, 10) ? m.volume[0].msat : '0')}</b></div>
      <div className="card stat"><span>Protocol reserve</span><b>{m.reserve ? amount(m.reserve.msat) : '–'}</b>
        <small>{m.reserve ? m.reserve.federations.length + (m.reserve.federations.length === 1 ? ' federation' : ' federations') : 'not read yet'}</small></div>
      <div className="card stat"><span>Referral fees paid</span><b>{m.referral ? amount(m.referral.msat) : '–'}</b>
        <small>{m.referral ? m.referral.sites.length + (m.referral.sites.length === 1 ? ' program' : ' programs') : 'not read yet'}</small></div>
    </div>
    <h2>Volume per day <span className="dim">stakes of every transaction, UTC days</span></h2>
    <div className="card">{(m.volume || []).length ? (<table className="rows"><thead><tr><th>Day</th><th>Transactions</th><th>Volume</th><th /></tr></thead><tbody>
      {m.volume.map((d) => <tr key={d.day}><td className="nw">{d.day}</td><td>{d.txs.toLocaleString('en-US')}</td><td className="nw"><b>{amount(d.msat)}</b></td>
        <td className="barcell"><i className="vbar" style={{ width: Math.max(1, Number((BigInt(d.msat) * 100n) / most)) + '%' }} /></td></tr>)}</tbody></table>) : <p className="dim">No transactions yet.</p>}</div>
    {m.referral && m.referral.sites.length ? (<><h2>Referral programs</h2><div className="card"><table className="rows"><thead><tr><th>Program</th><th>Key</th><th>Payouts</th><th>Earned</th></tr></thead><tbody>
      {m.referral.sites.map((x) => <tr key={x.site}><td><b>{x.name || 'unnamed'}</b></td><td className="mono">{x.site.slice(0, 16)}…</td><td>{x.payouts}</td><td className="nw"><b>{amount(x.msat)}</b></td></tr>)}</tbody></table></div></>) : null}
    {m.readAt ? <p className="dim">Reserve and referral fees read from {m.seats ? m.seats.reserves + ' of ' + m.seats.of : 'the'} nodes {ago(Date.parse(m.readAt))}.</p> : null}
  </>);
}

function Find() {
  const [q, setQ] = useState('');
  return (<form onSubmit={(e) => { e.preventDefault(); const v = q.trim().toLowerCase(); if (/^[0-9a-f]{64}$/.test(v)) location.href = '/tx/' + v; }}>
    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="transaction id (64 hex)" autoComplete="off" /><button>Find</button></form>);
}

function App() {
  const m = /^\/tx\/([0-9a-f]{64})\/?$/.exec(location.pathname);
  const metrics = /^\/metrics\/?$/.test(location.pathname);
  return (<>
    <nav><div className="in"><a className="brand" href="/"><i>₿</i>Arena Explorer</a>
      <span className="links"><a href="/" className={!m && !metrics ? 'on' : undefined}>Transactions</a><a href="/metrics" className={metrics ? 'on' : undefined}>Metrics</a></span><Find /></div></nav>
    <main>{m ? <Tx id={m[1]} /> : metrics ? <Metrics /> : <List />}</main>
  </>);
}

if (typeof document !== 'undefined' && document.getElementById('root')) createRoot(document.getElementById('root')).render(<App />);
