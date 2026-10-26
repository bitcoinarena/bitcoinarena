// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK HEALTH PAGE'S VIEWS IN REACT (kanban #564, slice 1 of src/arena-ui/health): the network's facts as stat cards, every census
// node as a row (active first, the inactive folded), and each federation's capacity band. The page still reads everything itself - six
// requests at a time, every 60 s - and hands each section its data; these class components only draw it. Its words are the page's own.
import React from 'react';

const sat = (v) => (v == null || v === '' ? '-' : Number(v).toLocaleString('en-US'));
const short = (h, n = 8) => (h ? String(h).slice(0, n) : '-');
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)} %` : '-');
export const Dot = ({ c }) => <span className={`dot ${c}`} />;

/** [label, value, tone] as stat cards. */
/** One line of words: { text, bad, warn } - the page's reading state ("reading …", "Data from 3 min ago (08:52 UTC)"), red when it failed,
 * yellow when what it shows is older than 5 minutes (kanban #686). */
export const Line = ({ text, bad, warn }) => (bad ? <span className="bad">{text}</span> : warn ? <span className="warn">{text}</span> : text);

export function Facts({ items }) {
  return <div className="facts r">{items.map(([k, v, c]) => <div key={k} className="fact"><b className={c || ''}>{String(v)}</b><span>{k}</span></div>)}</div>;
}

// WHAT A NODE EARNED (kanban #597): its dashboard's income - game/verify, settlement, guardian and other fees - in all and this month (UTC),
// in sat; null for a node whose dashboard did not answer. A seat before 597 has no "total" yet: its year stands in.
const INCOME = ['gameVerifyMsat', 'settlementMsat', 'guardianMsat', 'otherMsat'];
export const incomeSat = (t) => (t ? Math.floor(INCOME.reduce((s, k) => s + Number(t[k] || 0), 0) / 1000) : 0);
export function nodeEarnings(n) {
  const d = n.dash && n.dash.ok ? n.dash.body : null;
  if (!d || !d.totals) return null;
  return { total: incomeSat(d.totals.total || d.totals.year), month: incomeSat(d.totals.month) };
}

/** A node's row: its health dot, what it answered, its release and protocol, roles, serving, bond and lock, the last 24 h. */
export function nodeView(n, { tip, served = {}, fedNo = () => null, active }) {
  const v = n.version, b = n.bond;
  const health = !v ? 'warn' : !v.ok ? 'bad' : n.serving === false || v.ms > 3000 ? 'warn' : 'ok';
  const own = b && b.ok && b.body.bond ? b.body.bond : null;
  const bond = own || (n.bondSats ? { sats: n.bondSats } : null);
  const lock = own && b.body.lock ? b.body.lock : (n.bondMaturity != null && Number.isFinite(Number(tip)) ? { blocksLeft: Number(n.bondMaturity) - Number(tip) } : null);
  const tags = [...(n.roles || []), ...(n.guardianOf && n.guardianOf.length ? [n.guardianOf.map((f) => (fedNo(f) ? `federation ${fedNo(f)}` : `guardian of ${short(f, 6)}`)).join(', ')] : []),
    ...(n.liq && n.liq.ok ? ['liquidity'] : []), ...(n.gw && n.gw.ok ? ['gateway'] : [])];
  return { key: n.node || n.base, health, node: short(n.node, 12), address: (n.base || '').replace(/^https?:\/\//, ''),
    answer: !v ? null : v.ok ? `${v.ms} ms` : `${v.status || ''} ${v.why}`.trim(), answered: !!(v && v.ok),
    release: v && v.ok ? `${v.body.version || 'checkout'}` : '-', commit: v && v.ok && v.body.commit ? short(v.body.commit, 7) : null,
    protocol: v && v.ok ? Math.max(...(v.body.protocols || [0])) : null, tags, serving: n.serving,
    bond: bond ? `${sat(bond.sats)} sat` : '-', lock: lock ? (lock.blocksLeft > 0 ? `matures in ${lock.blocksLeft}` : 'mature') : null, lockWaits: !!(lock && lock.blocksLeft > 0),
    active, rounds24h: served[n.node] || 0, asked: !!v, earned: nodeEarnings(n) };
}

export class NodesTable extends React.Component {
  constructor(props) { super(props); this.state = { idleOpen: false }; }
  row(r, i) {
    return (
      <tr key={r.key}>
        <td><Dot c={r.health} />{i + 1}</td><td className="mono">{r.node}</td><td className="mono">{r.address}</td>
        <td>{r.answer === null ? <span className="muted">asking …</span> : r.answered ? r.answer : <span className="bad">{r.answer}</span>}</td>
        <td>{r.release}{r.commit ? <span className="mono muted"> {r.commit}</span> : null}</td>
        <td>{r.protocol === null ? '-' : r.protocol}</td>
        <td className="wrap">{r.tags.length ? r.tags.map((t) => <span key={t} className="tag">{t}</span>) : '-'}</td>
        <td>{r.serving == null ? '-' : r.serving ? <span className="ok">yes</span> : <span className="warn">no</span>}</td>
        <td>{r.bond}</td><td>{r.lock ? <span className={r.lockWaits ? 'warn' : ''}>{r.lock}</span> : '-'}</td>
        <td>{r.earned ? sat(r.earned.total) : '-'}</td><td>{r.earned ? sat(r.earned.month) : '-'}</td>
        <td>{!r.asked ? <span className="muted">-</span> : r.active ? <><span className="ok">active</span>{r.rounds24h ? <span className="muted"> · {r.rounds24h} round{r.rounds24h === 1 ? '' : 's'} in 24 h</span> : null}</> : <span className="muted">inactive</span>}</td>
      </tr>);
  }
  render() {
    const { rows } = this.props;
    const act = rows.filter((r) => r.active), idle = rows.filter((r) => !r.active);
    const open = this.state.idleOpen;
    return (
      <table>
        <thead><tr><th></th><th>Node key</th><th>Address</th><th>Answer</th><th>Release</th><th>Protocol</th><th>Roles</th><th>Serving</th><th>Bond</th><th>Bond lock</th><th>Earned (sat)</th><th>This month</th><th>Last 24 h</th></tr></thead>
        <tbody>
          {act.map((r, i) => this.row(r, i))}
          {idle.length ? <tr><td colSpan={13}><button type="button" className="fold" onClick={() => this.setState({ idleOpen: !open })}>{open ? '▾' : '▸'} {idle.length} inactive node{idle.length === 1 ? '' : 's'} - bonded, not answering and no round signed in 24 h</button></td></tr> : null}
          {open ? idle.map((r, i) => this.row(r, act.length + i)) : null}
        </tbody>
      </table>);
  }
}

const WORD = { CALM: ['ok', 'room left'], PRESSURE: ['warn', 'filling up'], CRITICAL: ['bad', 'deposits close soon'], FULL: ['bad', 'deposits closed'], NOT_OPEN: ['muted', 'takes no deposits'] };
/** Each federation's band as a card: its load as a bar against 100 %, what it means, who is below B* or P*; the network's band last. */
export function capacityView(cap, feds = [], fedNo = () => null) {
  if (!cap || !cap.federations) return null;
  const nm = (fid) => (fedNo(fid) ? `Federation ${fedNo(fid)}` : `Federation ${short(fid, 8)}`);
  const into = (fid) => (fedNo(fid) ? `Federation ${fedNo(fid)}` : short(fid, 8));
  const rows = cap.federations.map((f) => {
    const [tone, word] = WORD[f.band] || ['muted', f.band];
    const succ = (feds || []).find((x) => x.federation === f.federation && x.successor);
    const say = f.band === 'NOT_OPEN' ? `${nm(f.federation)} is ${['DRAINING', 'CRITICAL'].includes(f.status) ? 'draining' : String(f.status).toLowerCase()}${succ ? ` into ${into(succ.successor)}: new deposits and rounds go there` : ''}.`
      : f.band === 'FULL' ? `Deposits into ${into(f.federation)} are closed until bonds rise or a new federation is founded.`
      : f.band === 'CRITICAL' ? `Deposits into ${into(f.federation)} will close soon (${pct(f.load)}).`
      : f.band === 'PRESSURE' ? `${nm(f.federation)} holds ${pct(f.load)} of what its bonds cover. Deposits stop at 100 %.`
      : `${nm(f.federation)}: ${pct(f.load)} of what its bonds cover.`;
    const below = f.band !== 'CALM' && f.band !== 'NOT_OPEN' && (f.guardiansBelowTarget || []).length
      ? `${f.guardiansBelowTarget.length} of ${f.guardians} guardians below the bond B* = ${sat(f.targetBondSats)} sat - increase your bond by ${[...new Set(f.guardiansBelowTarget.map((g) => sat(g.addSats)))].join(' / ')} sat (Add to bond).` : null;
    const gw = f.band !== 'CALM' && f.band !== 'NOT_OPEN' && (f.gatewaysBelowTarget || []).length ? `${f.gatewaysBelowTarget.length} gateway(s) below the peg-in P* = ${sat(f.targetPegInSats)} sat.` : null;
    return { key: f.federation, name: nm(f.federation), band: f.band === 'NOT_OPEN' ? f.status : f.band, status: f.band === 'NOT_OPEN' ? null : f.status, tone, word, say, below, gw,
      load: f.band === 'NOT_OPEN' || typeof f.load !== 'number' ? null : f.load, room: f.band === 'NOT_OPEN' ? null : `room ${sat(f.headroomSats)} sat` };
  });
  const n = cap.network || {};
  const network = { band: n.band || '-', tone: (WORD[n.band] || ['muted'])[0],
    say: `the lowest-load OPEN federation ${n.lowestFederation ? (fedNo(n.lowestFederation) ? `(Federation ${fedNo(n.lowestFederation)})` : short(n.lowestFederation, 8)) : '-'} at ${pct(n.lowestLoad)}`
      + `${n.band && n.band !== 'CALM' ? ` · a bond of at least ${sat(n.targetBondSats)} sat puts a node first in line for the next federation` : ''} · new installs bond at least ${sat(n.installMinimumBondSats)} sat` };
  return { rows, network };
}

export function Capacity({ view }) {
  if (!view) return <div className="muted">no seat answers /capacity yet</div>;
  return (
    <div className="cap">
      {view.rows.map((r) => (
        <div key={r.key} className={`capcard ${r.tone}`}>
          <div className="caphead"><b>{r.name}</b><span className={`pill ${r.tone}`}>{r.band}</span>{r.status ? <span className="muted">{r.status}</span> : null}<span className="muted grow">{r.word}</span>{r.room ? <span className="muted">{r.room}</span> : null}</div>
          {r.load !== null ? <div className="loadbar"><i className={r.tone} style={{ width: `${Math.min(100, Math.round(r.load * 100))}%` }} /><span>{pct(r.load)}</span></div> : null}
          <p>{r.say}</p>
          {r.below ? <p className="warn">{r.below}</p> : null}
          {r.gw ? <p className="warn">{r.gw}</p> : null}
        </div>))}
      <div className="capnet"><Dot c={view.network.tone} /><b>Network: {view.network.band}</b> - {view.network.say}</div>
    </div>);
}

// A TABLE FROM THE PAGE'S DATA (slice 2: federations, liquidity providers, LND, games): { head: [titles], rows: [{ key, dot, cells,
// cls }], empty, foot }. A cell is text, { t, c } (text in a class), { t, c, tip } (with a tooltip, kanban #692), { bar: [have, need] }
// (how far, as a bar) or a list of those, joined by spaces - plain strings, never HTML.
export const barPct = (have, need) => (need ? Math.min(100, Math.round((100 * have) / need)) : 0);
const Part = ({ p }) => (p && typeof p === 'object'
  ? (p.bar ? <span className="tbar"><i className={barPct(...p.bar) >= 100 ? 'ok' : 'warn'} style={{ width: `${barPct(...p.bar)}%` }} /></span> : <span className={p.c || undefined} title={p.tip || undefined}>{p.t}</span>)
  : <>{p == null ? '' : String(p)}</>);
const Cell = ({ c }) => (Array.isArray(c) ? <>{c.map((p, i) => <React.Fragment key={i}>{i ? ' ' : null}<Part p={p} /></React.Fragment>)}</> : <Part p={c} />);
export function Table({ head, rows, empty, foot }) {
  return (
    <table>
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.length ? rows.map((r, ri) => (
          <tr key={r.key || ri}>{r.cells.map((c, i) => <td key={i} className={(r.cls && r.cls[i]) || undefined}>{i === 0 && r.dot ? <Dot c={r.dot} /> : null}<Cell c={c} /></td>)}</tr>))
          : <tr><td colSpan={head.length} className="muted">{empty}</td></tr>}
        {foot ? <tr><td colSpan={head.length} className="muted">{foot}</td></tr> : null}
      </tbody>
    </table>);
}

// MACHINES (kanban #597, testnet4 only - 2026-10-23: "a section machines where each machine is listed with all its nodes ... the
// machines folded as an accordion, in the title the number of nodes and the load 1, 5, 15 m, total sats earned, per month earned"): the
// nodes grouped by the machine id each one's /owner/version names (machine.js: a hash of its host), the load the newest of them answered,
// and the sum of their earnings. A node that names no machine (mainnet, or a release before 597) is counted, not grouped.
const loadTone = (load, cores) => { const x = Number(load) / Math.max(1, Number(cores) || 1); return x >= 1 ? 'bad' : x >= 0.7 ? 'warn' : 'ok'; };
export function machinesView(nodes) {
  const by = new Map();
  let unnamed = 0;
  for (const n of nodes) {
    const m = n.version && n.version.ok ? n.version.body.machine : null;
    if (!m || !m.id) { if (n.version && n.version.ok) unnamed++; continue; }
    const g = by.get(m.id) || { id: m.id, name: m.name || null, os: m.os || null, load: m.load || [], cores: m.cores || null, nodes: [], total: 0, month: 0 };
    if (!g.name && m.name) g.name = m.name;
    const e = nodeEarnings(n);
    if (e) { g.total += e.total; g.month += e.month; }
    g.nodes.push({ key: n.node || n.base, node: short(n.node, 12), address: (n.base || '').replace(/^https?:\/\//, ''),
      release: n.version.body.version || 'checkout', total: e ? e.total : null, month: e ? e.month : null });
    by.set(m.id, g);
  }
  const machines = [...by.values()].sort((a, b) => (b.nodes.length - a.nodes.length) || a.id.localeCompare(b.id))
    .map((g, i) => ({ ...g, title: g.name || `Machine ${i + 1}`, tone: loadTone(g.load[0], g.cores) }));
  return { machines, unnamed };
}
const loadText = (l) => (l && l.length === 3 ? l.map((x) => Number(x).toFixed(2)).join(' · ') : '-');
export class Machines extends React.Component {
  constructor(props) { super(props); this.state = { open: {} }; }
  render() {
    const { view } = this.props;
    if (!view || !view.machines.length) return <div className="muted">no node names its machine yet{view && view.unnamed ? ` (${view.unnamed} answering nodes run a release before it)` : ''}</div>;
    const open = this.state.open;
    return (
      <div className="machines">
        {view.machines.map((m) => (
          <div key={m.id} className="machine">
            <button type="button" className="fold mhead" onClick={() => this.setState({ open: { ...open, [m.id]: !open[m.id] } })}>
              <span>{open[m.id] ? '▾' : '▸'}</span><Dot c={m.tone} /><b>{m.title}</b>{m.os ? <span className="tag">{m.os}</span> : null}<span className="mono muted">{m.id.slice(0, 8)}</span>
              <span>{m.nodes.length} node{m.nodes.length === 1 ? '' : 's'}</span>
              <span>load {loadText(m.load)}{m.cores ? <span className="muted"> ({m.cores} cores)</span> : null}</span>
              <span>earned {sat(m.total)} sat</span><span>this month {sat(m.month)} sat</span>
            </button>
            {open[m.id] ? (
              <table>
                <thead><tr><th>Node key</th><th>Address</th><th>Release</th><th>Earned (sat)</th><th>This month</th></tr></thead>
                <tbody>{m.nodes.map((n) => (
                  <tr key={n.key}><td className="mono">{n.node}</td><td className="mono">{n.address}</td><td>{n.release}</td>
                    <td>{n.total == null ? '-' : sat(n.total)}</td><td>{n.month == null ? '-' : sat(n.month)}</td></tr>))}
                </tbody>
              </table>) : null}
          </div>))}
        {view.unnamed ? <div className="muted">{view.unnamed} answering node{view.unnamed === 1 ? '' : 's'} name no machine (a release before it)</div> : null}
      </div>);
  }
}

// APPS (kanban #597): every app the seats host, its newest version, and what the nodes earned from it - in all and this month - summed
// from every node's dashboard (byGame: each version's game id, so all versions of an app add up under its name)
export function appsView(games, nodes) {
  const byName = new Map(), nameOfId = new Map();
  for (const x of games || []) {
    const k = x.name || x.title;
    const a = byName.get(k) || { name: k, title: x.title || k, type: x.type || '-', newest: null, total: 0, month: 0 };
    if (x.version != null && (a.newest == null || Number(x.version) > Number(a.newest))) a.newest = x.version;
    byName.set(k, a); nameOfId.set(String(x.id).toLowerCase(), k);
  }
  for (const n of nodes) {
    const d = n.dash && n.dash.ok ? n.dash.body : null;
    for (const g of (d && d.byGame) || []) {
      const k = nameOfId.get(String(g.game).toLowerCase()) || g.name || short(g.game, 8);
      const a = byName.get(k) || { name: k, title: k, type: '-', newest: null, total: 0, month: 0 };
      a.total += incomeSat(g.earned); a.month += incomeSat(g.month);
      byName.set(k, a);
    }
  }
  return [...byName.values()].sort((a, b) => (b.total - a.total) || a.title.localeCompare(b.title));
}
