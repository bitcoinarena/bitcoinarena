// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EXPLORER IN REACT (kanban #624, the owner 2026-10-24: "Is it all react?"; "Group the timings by placement, lock, attestation, settlement
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
export const appName = (a) => ({ 'btc-updown-15m': 'Bitcoin Up or Down', '-': 'unknown' })[a] || a || 'unknown';
const given = typeof window !== 'undefined' ? window.EXPLORER_DATA || {} : {};

// ---- the list --------------------------------------------------------------------------------------------------------------------------
const FILTER_KEYS = ['app', 'fed', 'since', 'q'];
const PERIODS = [['', 'Any time'], ['900', 'Last 15 min'], ['3600', 'Last hour'], ['86400', 'Last 24 h'], ['604800', 'Last 7 days']];
const filterOf = () => { const u = new URLSearchParams(location.search); return Object.fromEntries(FILTER_KEYS.map((k) => [k, u.get(k) || ''])); };
const appOf = (t) => t.app || '-';   // '-': a row read before the seats named apps

function List() {
  const [txs, setTxs] = useState(Array.isArray(given.recent) ? given.recent : kept('explorer.recent') || []);
  const [f, setF] = useState(filterOf());
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (Array.isArray(given.recent)) { keep('explorer.recent', given.recent); return; }
    fetch('/api/recent').then((r) => r.json()).then((r) => { setTxs(r.txs); keep('explorer.recent', r.txs); }, (e) => setErr(e.message));
  }, []);
  const set = (k, v) => { const g = { ...f, [k]: v }; const u = new URLSearchParams(); for (const x of FILTER_KEYS) if (g[x]) u.set(x, g[x]);
    history.replaceState(null, '', '/' + (u.toString() ? '?' + u : '')); setF(g); };
  const now = Date.now();
  const apps = useMemo(() => [...new Set(txs.map(appOf))].sort(), [txs]);
  const feds = useMemo(() => [...new Set(txs.map((t) => t.federation).filter(Boolean))].sort(), [txs]);
  const shown = txs.filter((t) => (!f.app || appOf(t) === f.app) && (!f.fed || t.federation === f.fed) && (!f.since || now - t.storedMs <= Number(f.since) * 1000)
    && (!f.q || t.id.includes(f.q.toLowerCase()) || String(t.round).includes(f.q.toLowerCase())));
  if (err && !txs.length) return <p className="bad">The explorer could not be read: {err}</p>;
  return (<>
    <h1>Newest transactions</h1><p className="dim">Every order the nodes stored, read from them every minute and kept here.</p>
    <div className="filters">
      <select value={f.app} onChange={(e) => set('app', e.target.value)}><option value="">All apps</option>
        {apps.map((a) => <option key={a} value={a}>{appName(a)} ({txs.filter((t) => appOf(t) === a).length})</option>)}</select>
      <select value={f.fed} onChange={(e) => set('fed', e.target.value)}><option value="">All federations</option>
        {feds.map((x) => <option key={x} value={x}>Federation {x.slice(0, 8)}</option>)}</select>
      <select value={f.since} onChange={(e) => set('since', e.target.value)}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <input placeholder="part of an id or round" value={f.q} onChange={(e) => set('q', e.target.value.trim())} autoComplete="off" />
      <span className="dim">{shown.length.toLocaleString('en-US')} of {txs.length.toLocaleString('en-US')}</span>
    </div>
    <div className="card"><table><thead><tr><th>Transaction</th><th>App</th><th className="n">Amount</th><th>Federation</th><th>Round</th><th>Stored</th></tr></thead><tbody>
      {shown.slice(0, 300).map((t) => (<tr key={t.id}><td className="mono"><a href={'/tx/' + t.id}>{t.id.slice(0, 16)}…</a></td><td>{appName(appOf(t))}</td><td className="n nw">{t.stakeMsat !== null && t.stakeMsat !== undefined ? (Number(t.stakeMsat) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' sat' : '–'}</td>
        <td className="mono">{t.federation ? t.federation.slice(0, 8) : '–'}</td><td className="mono">{String(t.round || '').slice(0, 12)}</td>
        <td>{utc(t.storedMs).slice(0, 19)} UTC <span className="dim">{ago(t.storedMs)}</span></td></tr>))}
      {!shown.length ? <tr><td colSpan={6} className="dim">None match.</td></tr> : null}</tbody></table></div>
  </>);
}

// ---- one transaction -------------------------------------------------------------------------------------------------------------------
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
      add(d.atMs, group, s.seat, d.door + ' door' + (away ? ': not one of its round\'s nodes (holds no entry), 404' : ''),
        { took: away ? null : d.ms, detail: away ? '' : (d.steps || []).map((x) => x.step + ' ' + x.ms).join(', '), bad: !away && !(d.status >= 200 && d.status < 300), status: d.status, kind: away ? 'away' : 'door', away });
    }
    if (s.storedAt) add(Date.parse(s.storedAt), 'placement', s.seat, 'stored the entry', { kind: 'stored' });
    if (s.book && s.book.receivedAt) add(Date.parse(s.book.receivedAt), 'placement', s.seat, 'took the order into its book' + (s.book.batch ? ' (batch ' + s.book.batch + ')' : ''), { kind: 'book' });
    for (const k of ['stake', 'fee']) { const l = s.locks && s.locks[k]; if (l && l.verifiedAt) add(Date.parse(l.verifiedAt), 'lock', s.seat, 'verified the ' + k + ' lock', { detail: l.outpoint || '', kind: k + 'lock' }); }
    for (const d of s.did || []) add(d.atMs, 'settlement', s.seat, d.what, { detail: d.detail || '', kind: 'settle' });
  }
  const p = tx.processed;
  if (p) {
    for (const o of p.outcomes || []) {
      add(Date.parse(o.observedAt), 'attestation', 'attestors', 'observed the result: ' + (o.value !== null ? 'value ' + o.value : 'outcome ' + o.outcome), { kind: 'outcome' });
      add(Date.parse(o.receivedAt), 'attestation', 'nodes', 'received the result\'s attestation', { detail: (o.attestors || []).map((k) => (p.names && p.names[k]) || k.slice(0, 12)).join(', '), kind: 'outcome' });
    }
    if (p.settledAt) add(Date.parse(p.settledAt), 'settlement', 'nodes', 'settlement made' + (tx.settlement ? ': ' + tx.settlement.state : ''), { detail: tx.settlement ? tx.settlement.txid : '', kind: 'settle' });
  }
  const c = tx.client, press = c && c.pressedAt ? Date.parse(c.pressedAt) : null;
  if (press) {
    add(press, 'page', 'page', 'order pressed', { kind: 'page' });
    for (const x of c.steps || []) add(press + x.ms, 'page', 'page', x.step, { kind: 'page' });
    for (const [k, v] of [['submitted (first node took the entry)', c.submittedMs], ['placed (enough nodes took it)', c.placedMs], ['lock accepted by the guardians', c.lockMs]]) if (Number.isFinite(v)) add(press + v, 'page', 'page', k, { kind: 'page' });
  }
  return ev.sort((a, b) => a.atMs - b.atMs || (a.where < b.where ? -1 : 1));
}

const GROUPS = [['placement', 'Placement', 'handout, entry, stored, order book'], ['lock', 'Lock', 'stake and fee lock handed and verified'],
  ['attestation', 'Attestation', 'the result observed and attested'], ['settlement', 'Settlement', 'each node\'s settlement steps, the settlement'],
  ['page', 'At the page', 'the page\'s own steps, where it handed them']];

function Group({ id, title, hint, events, rel }) {
  const real = events.filter((x) => !x.away);
  const nodes = new Set(real.filter((x) => x.where !== 'page').map((x) => x.where)).size;
  const span = real.length ? `${rel(real[0].atMs)} → ${rel(real[real.length - 1].atMs)}` : '';
  return (
    <details className="grp" id={'g-' + id}>
      <summary><b>{title}</b> <span className="dim">{events.length ? `${span} · ${events.length} event(s)${nodes ? ' at ' + nodes + ' node(s)' : ''}` : 'nothing yet'}</span>
        <span className="hint dim">{hint}</span></summary>
      {events.length ? (<table><thead><tr><th>UTC</th><th>From start</th><th>Where</th><th>What</th><th>Took</th><th>Detail</th></tr></thead><tbody>
        {events.map((x, i) => (<tr key={i} className={x.away ? 'away' : x.group === 'page' ? 'pg' : ''}><td className="mono nw"><span className="day">{utc(x.atMs).slice(0, 11)}</span>{utc(x.atMs).slice(11)}</td>
          <td className={'nw' + (rel.ms(x.atMs) > 3000 ? ' slow' : '')}>{rel(x.atMs)}</td><td className="nw">{x.where}</td>
          <td>{x.what}{x.bad ? <span className="bad"> {x.status}</span> : null}</td><td className="nw">{Number.isFinite(x.took) ? x.took + ' ms' : ''}</td>
          <td className="dim mono">{x.detail || ''}</td></tr>))}</tbody></table>) : <p className="dim">Nothing recorded yet.</p>}
    </details>);
}

function Processed({ tx }) {
  const p = tx.processed; if (!p) return null;
  const nm = (k) => (p.names && p.names[k] ? p.names[k] : String(k).slice(0, 12) + '…');
  const list = (ks) => (ks && ks.length ? ks.map((k, i) => <span key={k}>{i ? ', ' : ''}{k === p.asker ? <b>{nm(k)} (asker)</b> : nm(k)}</span>) : <span className="dim">–</span>);
  return (<details className="grp"><summary><b>Who processed the round</b> <span className="dim">the game's and the settlement's nodes, the asker, the result's attestors</span></summary>
    <dl>
      <dt>Ran the game</dt><dd>{list(p.game)}</dd><dt>Signs the settlement</dt><dd>{list(p.settlement)}</dd>
      <dt>Asker</dt><dd>{p.asker ? <>{nm(p.asker)} <span className="dim">combines and submits the settlement first; the next takes over if it does not</span></> : '–'}</dd>
      <dt>Result attested by</dt><dd>{(p.outcomes || []).length ? p.outcomes.map((o, i) => <div key={i}>{(o.attestors || []).map(nm).join(', ') || '–'} <span className="dim">· observed {utc(Date.parse(o.observedAt)).slice(0, 19)} UTC</span></div>) : <span className="dim">not yet</span>}</dd>
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
  if (!tx) return missing ? <><h1>Not found</h1><p className="dim">No node holds the transaction {id}.</p></> : err ? <p className="bad">The explorer could not be read: {err}</p> : <p className="dim">Reading the nodes …</p>;
  const e = tx.entry || {};
  const ev = timelineOf(tx);
  const nodeEv = ev.filter((x) => x.group !== 'page' && !x.away);
  // THE ORDER'S START: the press where the page handed it, else the first node it reached - so nothing is before it (the owner 2026-10-24:
  // "Negative timings": the page's steps come before the first node)
  const press = ev.find((x) => x.group === 'page');
  const t0 = press ? press.atMs : nodeEv.length ? nodeEv[0].atMs : ev.length ? ev[0].atMs : Date.now();
  const rel = (ms) => { const d = (ms - t0) / 1000; return (d < 0 ? '−' : '+') + Math.abs(d).toFixed(2) + ' s'; };
  rel.ms = (ms) => ms - t0;
  // THE NODE SIDE, SUMMED UP: for each step the first node's, the half-way node's and the last node's time from the first node it reached
  const steps = [['door', 'reached the node'], ['stored', 'entry stored'], ['stakelock', 'stake lock verified'], ['feelock', 'fee lock verified'], ['book', 'in the order book'], ['settle', 'settlement step']]
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
      <dt>Settlement</dt><dd className="mono">{tx.settlement ? tx.settlement.state + ' · ' + tx.settlement.txid : <span className="dim">not yet</span>}</dd>
      <dt>Start</dt><dd>{utc(t0)} UTC <span className="dim">{press ? 'the press at the page' : 'the first node it reached'}</span></dd>
      <dt>Read</dt><dd className="dim">{tx.cached ? 'from the explorer\'s store' : 'from the nodes'} · {known} node(s) hold it</dd></dl></div>
    <h2>At the nodes <span className="dim">(from the start{press ? ', the press' : ', the first node it reached'}: first · half the nodes · last)</span></h2>
    <div className="card">{steps.length ? (<table><thead><tr><th>Step</th><th>First</th><th>Half</th><th>Last</th><th>Nodes</th></tr></thead><tbody>
      {steps.map((s) => <tr key={s.label}><td>{s.label}</td><td className="nw">{rel(s.first)}</td><td className="nw">{rel(s.half)}</td><td className="nw">{rel(s.last)}</td><td className="dim nw">{s.n}</td></tr>)}</tbody></table>)
      : <p className="dim">No node kept steps for it.</p>}</div>
    <h2>History <span className="dim">(every node's record{tx.client ? ' and the page\'s steps' : ''}, one clock - open a group)</span></h2>
    {GROUPS.filter(([g]) => g !== 'page' || tx.client).map(([g, title, hint]) => <Group key={g} id={g} title={title} hint={hint} events={ev.filter((x) => x.group === g)} rel={rel} />)}
    <Processed tx={tx} />
    <details className="grp"><summary><b>Nodes</b> <span className="dim">{known} of {(tx.seats || []).length} hold it</span></summary>
      <table><thead><tr><th>Node</th><th>Holds it</th><th>Stored</th><th>Book</th></tr></thead><tbody>{(tx.seats || []).map((s) => (<tr key={s.seat}><td>{s.seat}</td>
        <td className={s.known ? 'ok' : 'dim'}>{s.known ? 'yes' : s.status ? 'no' : 'no answer'}</td><td>{s.storedAt ? rel(Date.parse(s.storedAt)) : '–'}</td>
        <td className="dim">{s.book ? 'batch ' + (s.book.batch || '–') : ''}</td></tr>))}</tbody></table></details>
  </>);
}

function Find() {
  const [q, setQ] = useState('');
  return (<form onSubmit={(e) => { e.preventDefault(); const v = q.trim().toLowerCase(); if (/^[0-9a-f]{64}$/.test(v)) location.href = '/tx/' + v; }}>
    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="transaction id (64 hex)" autoComplete="off" /><button>Find</button></form>);
}

function App() {
  const m = /^\/tx\/([0-9a-f]{64})\/?$/.exec(location.pathname);
  return (<>
    <nav><div className="in"><a className="brand" href="/"><i>₿</i>Arena Explorer</a><Find /></div></nav>
    <main>{m ? <Tx id={m[1]} /> : <List />}</main>
  </>);
}

if (typeof document !== 'undefined' && document.getElementById('root')) createRoot(document.getElementById('root')).render(<App />);
