// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE DASHBOARD, IN REACT (kanban #566, 2026-10-21: "this looks very off and doesn't even fit. Make it look much more modern,
// the entire page as well"): the same /dashboard.json drawn as cards that size to their content - what the node earned in the period
// chosen as one large number with its roles as a bar, what it is owed, its profit; the 30 days as a stacked chart; the dev clients
// each in a card whose table fits (short dates, one line each); the hosts and the games; the rounds, settlements and federations as
// tables that scroll inside their card. Empty rows are left out; nothing runs past its card on a desktop or a phone.
// THE ONLY DRAWING (kanban #564, 2026-10-21: "Delete the old html code of those components you have ported, no fall backs"): what
// the page's own script drew is here too - a round opened to its players with their replays (readResult), the notes, every host row,
// the capacity plea and the liquidity card (the page hands in liquidity-claim and capacity?node=me), and the words for an unreadable node.
import React from 'react';
import { ceilingLine } from '../owner/RoundsPanel.jsx';
import { SetupStatus, FoundingWait, PegInCard, NoBondCard, noBond } from './SetupStatus.jsx';
import { CopyButton } from '../design/components.jsx';
import { UptimeStats } from './Uptime.jsx';

/** msat to the page's sat: three decimals under 10, one under 1,000, none above. */
export const sat = (m) => { const n = Number(m || 0) / 1000; return `${(n < 10 ? n.toFixed(3) : n.toFixed(n < 1000 ? 1 : 0)).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')} sat`; };
/** A short date: "21 Oct 10:16" this year, with the year otherwise. */
export const short = (ms, nowMs = Date.now()) => {
  if (!ms) return '-';
  const d = new Date(Number(ms)), now = new Date(nowMs);
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const hm = d.toISOString().slice(11, 16);
  return `${d.getUTCDate()} ${mon}${d.getUTCFullYear() !== now.getUTCFullYear() ? ` ${d.getUTCFullYear()}` : ''} ${hm}`;
};
export const ROLES = Object.freeze([['gameVerifyMsat', 'Game / verify', 'var(--gv)'], ['settlementMsat', 'Settlement', 'var(--st)'], ['guardianMsat', 'Guardian', 'var(--gd)'], ['otherMsat', 'Other', 'var(--dim)']]);
export const PERIOD = Object.freeze({ day: 'Today', month: 'This month', year: 'This year' });
const big = (x) => BigInt(x || 0);
/** The period's earnings: the total earned, its parts by role (only those above 0), the costs, the profit. */
export function earningsOf(T) {
  const parts = ROLES.map(([k, name, color]) => ({ k, name, color, msat: big(T[k]) })).filter((p) => p.msat > 0n);
  const earned = parts.reduce((a, p) => a + p.msat, 0n);
  const costs = big(T.lightningCostMsat) + big(T.gatewayCostMsat);
  return { parts, earned, costs, profit: big(T.profitMsat) };
}

class Stat extends React.Component {
  render() { const { label, value, sub, tone } = this.props; return <div className="stat"><span>{label}</span><b className={tone || undefined}>{value}</b>{sub ? <small>{sub}</small> : null}</div>; }
}

/** A card of label-value rows; rows whose value is empty are left out. */
class Rows extends React.Component {
  render() {
    const rows = (this.props.rows || []).filter(([, v]) => v !== null && v !== undefined && v !== '');
    return <div className="kv">{rows.map(([k, v], i) => <div key={i} className="row"><span>{k}</span><b>{v}</b></div>)}</div>;
  }
}

export class Earnings extends React.Component {
  render() {
    const { totals, period, onPeriod } = this.props;
    const e = earningsOf(totals[period]); const owed = totals.owed || {};
    const owedSum = big(owed.gameVerifyMsat) + big(owed.settlementMsat) + big(owed.guardianMsat);
    return (
      <div>
        <div className="seg" role="tablist" onKeyDown={(ev) => {
          // arrow keys move between the periods, and only the chosen one is in the tab order (kanban #847)
          const keys = Object.keys(PERIOD), step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
          if (!step) return;
          ev.preventDefault();
          const next = (keys.indexOf(period) + step + keys.length) % keys.length;
          onPeriod(keys[next]); ev.currentTarget.children[next].focus();
        }}>{Object.entries(PERIOD).map(([p, name]) => (
          <button key={p} type="button" role="tab" id={`earn-tab-${p}`} aria-controls="earn-panel" aria-selected={p === period} tabIndex={p === period ? 0 : -1} className={p === period ? 'on' : undefined} onClick={() => onPeriod(p)}>{name}</button>))}</div>
        <div className="stats" role="tabpanel" id="earn-panel" aria-labelledby={`earn-tab-${period}`}>
          <div className="stat wide"><span>Earned · {PERIOD[period].toLowerCase()}</span><b>{sat(e.earned)}</b>
            {e.parts.length ? <>
              <div className="split" aria-hidden="true">{e.parts.map((p) => <i key={p.k} style={{ flex: `${Number(p.msat)} 0 0`, background: p.color }} />)}</div>
              <small className="split-legend">{e.parts.map((p) => <span key={p.k}><i style={{ background: p.color }} />{p.name} {sat(p.msat)}</span>)}</small></>
              : <small>nothing settled yet in this period</small>}</div>
          <Stat label="Owed" value={sat(owedSum)} sub="rounds played, not settled yet" />
          <Stat label="Profit" value={sat(e.profit)} tone={e.profit > 0n ? 'ok' : undefined} sub={e.costs > 0n ? `after ${sat(e.costs)} of Lightning and gateway costs` : 'no costs'} />
        </div>
      </div>);
  }
}

/** The last 30 days, stacked by role; a tap or the pointer names the day. */
export class Chart extends React.Component {
  constructor(props) { super(props); this.state = { at: null }; }
  render() {
    const days = this.props.days || []; const W = 1000, H = 200, P = 8;
    const sum = (d) => Number(d.gameVerifyMsat) + Number(d.settlementMsat) + Number(d.guardianMsat);
    const max = Math.max(1, ...days.map(sum)); const bw = (W - 2 * P) / Math.max(1, days.length);
    const hov = this.state.at !== null ? days[this.state.at] : null;
    return (
      <div className="chart">
        <div className="chart-head"><span className="legend">{ROLES.slice(0, 3).map(([k, n, c]) => <span key={k}><i style={{ background: c }} />{n}</span>)}</span>
          <span className="sub">{hov ? `${hov.day}: ${sat(sum(hov))}` : `last ${days.length} days · tap a day`}</span></div>
        <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="fees earned per day" onPointerLeave={() => this.setState({ at: null })}>
          {days.map((d, i) => {
            let y = H; const x = P + i * bw + 2, w = Math.max(1, bw - 4);
            const parts = [['gameVerifyMsat', 'var(--gv)'], ['settlementMsat', 'var(--st)'], ['guardianMsat', 'var(--gd)']].map(([k, c]) => { const h = (H - 6) * Number(d[k]) / max; y -= h; return <rect key={k} x={x} y={y} width={w} height={h} fill={c} rx="2" />; });
            return (
              <g key={d.day} tabIndex={0} aria-label={`${d.day}: ${sat(sum(d))}`} style={{ cursor: 'pointer' }} onFocus={() => this.setState({ at: i })} onBlur={() => this.setState({ at: null })} onPointerEnter={() => this.setState({ at: i })} onPointerDown={() => this.setState({ at: i })}>
                <rect x={x - 2} y="0" width={bw} height={H} fill={this.state.at === i ? 'rgba(127,127,127,.12)' : 'transparent'} />{parts}</g>);
          })}
        </svg>
        {/* in page pixels, not the drawing's: 13 units of 1000 were 6 px on a laptop and 4 on a phone (kanban #846) */}
        <div className="chart-days" aria-hidden="true">{days.filter((d, i) => i % 5 === 0).map((d) => <span key={d.day}>{d.day.slice(5)}</span>)}</div>
      </div>);
  }
}

export class DevClient extends React.Component {
  render() {
    const V = this.props.client; const now = this.props.nowMs;
    if (V.error) return <div className="card"><h3>Dev client{V.label ? ` · ${V.label}` : ''}</h3><p className="bad">Not read: {V.error}</p></div>;
    const S = V.split || {}; const w = (V.withdrawals || [])[0];
    return (
      <div className="card dev">
        <div className="card-head"><h3>Dev client{V.label ? ` · ${V.label}` : ''}</h3><code className="sub">{String(V.recipientPk || '').slice(0, 12)}…</code></div>
        <div className="stats">
          <Stat label="Received" value={sat(V.receivedMsat)} sub={`${V.donations} donation${V.donations === 1 ? '' : 's'}`} />
          <Stat label="Withdrawn" value={sat(V.withdrawnMsat)} sub={w ? `last ${short(Date.parse(w.at), now)} · ${w.state || '?'}` : 'none yet'} />
          {(V.byFederation || []).map((f) => <Stat key={f.federation} label={`In ${f.federation.slice(0, 8)}`} value={f.balanceMsat !== null ? sat(f.balanceMsat) : sat(f.msat)} sub={`${f.donations} donations · ${sat(f.msat)} in`} />)}
        </div>
        <Rows rows={[['For the protocol developers', S.protocolMsat ? sat(S.protocolMsat) : null],
          ...(S.games || []).map((g) => [`For ${g.title || g.game}`, `${sat(g.msat)} · ${g.donations}`]),
          ['Rounds this node no longer holds', S.unknownMsat && S.unknownMsat !== '0' ? sat(S.unknownMsat) : null],
          ['Unclaimed in issuance', (V.unclaimed || []).length ? V.unclaimed.map((u) => sat(u.msat)).join(', ') : null],
          ['Last recovery', V.lastRecovery ? `${short(Date.parse(V.lastRecovery.at), now)} · ${V.lastRecovery.ok ? `ok, +${sat(V.lastRecovery.unclaimedMsat)}` : `failed: ${V.lastRecovery.why || ''}`}` : null],
          ['Last pass', V.lastPass ? `${short(Date.parse(V.lastPass.at), now)} · asked ${V.lastPass.seats} nodes${V.lastPass.unanswered ? ` (${V.lastPass.unanswered} unanswered)` : ''}` : null]]} />
        {(V.recent || []).length ? (
          <div className="scroll"><table className="tbl"><thead><tr><th>Round</th><th>Federation</th><th className="n">Donation</th><th className="n">When</th></tr></thead>
            <tbody>{V.recent.map((x, i) => <tr key={i}><td><code>{x.round.slice(0, 8)}</code></td><td><code>{x.federation.slice(0, 8)}</code></td><td className="n">{sat(x.amountMsat)}</td><td className="n nowrap">{short(x.atMs, now)}</td></tr>)}</tbody></table></div>) : null}
      </div>);
  }
}

/** A player's score as the node writes it: 100000ths, five decimals. */
export const score = (v) => (v === null || v === undefined ? '-' : `${Math.trunc(v / 100000)}.${String(Math.abs(v) % 100000).padStart(5, '0')}`);
/** A net with its sign: "+286 sat", "-4 sat", blank while pending. */
export const signedSat = (m) => (m === null || m === undefined || m === '' ? '' : `${Number(m) > 0 ? '+' : ''}${sat(m)}`);
/** A note's hyphens do not break (measured at 1280 px: "test-host- / testnet4"): a name in a note stays one word. */
// THE NOTES AS THREE SHORT ROWS (2026-10-26, the owner on the Money card's notes: "This is also a wall of text"): what, then a few words;
// the node's whole sentence stays as the row's tooltip
export function noteRows(D) {
  const n = D.notes || {}, h = D.hosts || {};
  const rows = [];
  // ONE SLIM LINE, NOT A CARD (2026-10-26, the owner: "Money Notes looks like a space waster, re arrange it to be more space efficient"):
  // a word or two each; the node's whole sentence is the tooltip
  if (n.guardian) rows.push(['Guardian fees', 'none until it guards a federation', n.guardian]);
  if (n.lightning) rows.push(['Lightning', h.lnd ? `LND ${h.lnd.alias || ''}`.trim() : 'no channel', n.lightning]);
  if (n.gateway) rows.push(['Gateway', h.gateway ? `${h.gateway.name || 'its own'} · no cost` : 'none used', n.gateway]);
  return rows;
}
// THE OWNER AREA ON THE ARENA SITE (2026-10-26, the owner on 2026.1.9.9: "It works via owner page but not Open Dashboard"): the link opened
// this node's own page at 127.0.0.1, another origin than the site's, which keeps the owner key the installer and the update hand over -
// so it asked for the 24 words. Now the site's page for this node's key, with this page's address when it is the node's own (127.0.0.1)
export const OWNER_SITE = 'https://testnet.bitcoinarena.io/owner/';
export function ownerHref(node, loc) {
  if (!/^[0-9a-f]{64}$/.test(String(node || ''))) return 'Dashboard/owner';
  const local = loc && /^(127\.0\.0\.1|localhost)$/.test(loc.hostname) ? `&local=${encodeURIComponent(loc.origin)}` : '';
  return `${OWNER_SITE}#node=${node}${local}`;
}
/** The owner area's Bond section (kanban #728): the site's page names it beside the node, the node's own page by its #. */
export function bondHref(node, loc) { const h = ownerHref(node, loc); return h.includes('#') ? `${h}&section=bond` : `${h}#bond`; }
export const keep = (t) => String(t).replace(/-/g, '‑');
const tone = (m) => (m === null || m === undefined || m === '' ? '' : Number(m) > 0 ? 'ok' : Number(m) < 0 ? 'bad' : '');

/** THE ROUNDS ARE CLICKABLE (2026-10-03, plan accepted 2026-10-04; in React for kanban #564): an opened round's players from this node's
 *  own api/round-result - every value the endpoint's own (outcome, score, signers, stake, result, netMsat) - each with its replay. */
export class Players extends React.Component {
  render() {
    const a = this.props.result;
    if (!a || a.loading) return <p className="sub">reading api/round-result…</p>;
    if (a.error) return <p className="bad">could not read api/round-result: {a.error}</p>;
    // the stake against its ceiling (§5A.10, kanban #1282): the owner page's words
    const ceil = a.ceiling ? <p className={`sub ceiling${a.ceiling.ok ? '' : ' bad'}`}>{ceilingLine(a.ceiling)}</p> : null;
    if (!(a.players || []).length) return <>{ceil}<p className="sub">no players in this round</p></>;
    return (<>{ceil}
      <table className="tbl"><thead><tr><th>Player</th><th>Outcome</th><th className="n">Score</th><th className="n">Signed by</th><th className="n">Stake</th><th>Won or lost</th><th className="n">Net</th><th>Replay</th></tr></thead>
        <tbody>{a.players.map((p, i) => { const c = tone(p.netMsat); return (
          <tr key={p.entry || i}><td>{p.name || ''}</td><td>{p.outcome || 'not signed yet'}</td><td className="n">{score(p.score)}</td><td className="n">{p.signedBy | 0}</td><td className="n">{sat(p.stakeMsat)}</td>
            <td className={c || undefined}>{p.result || ''}</td><td className={`n${c ? ` ${c}` : ''}`}>{signedSat(p.netMsat)}</td>
            <td><a href={`replay?round=${encodeURIComponent(a.id)}&entry=${encodeURIComponent(p.entry)}`} target="_blank" rel="noopener">replay</a></td></tr>); })}</tbody></table></>);
  }
}

/** THE LIQUIDITY CARD (§23A.10): a provider's free coins against the deposit minimum, the channels it gave, the top-up address. */
export const DEPOSIT_MIN_SATS = 500000;
export class Liquidity extends React.Component {
  render() {
    const c = this.props.claim; const g = c.channels || [];
    const free = Number(c.freeSats), given = g.reduce((a, x) => a + Number(x.capacitySats), 0), n = (x) => `${x.toLocaleString('en')} sat`;
    return (
      <section><h2>Liquidity provider</h2><div className="card">
        <Rows rows={[['Free for new channels', n(free)], ['Deposit minimum (free + channels given)', n(DEPOSIT_MIN_SATS)]]} />
        {free + given < DEPOSIT_MIN_SATS ? <p className="bad">Below the deposit minimum: no share of the liquidity pool until topped up.</p>
          : <p className="ok">Above the deposit minimum: earning its share of the liquidity pool.</p>}
        <Rows rows={[['Channels given', `${g.length} (${n(given)})`], ['Top up (LND wallet)', <code>{String(c.depositAddress || '-')}</code>]]} />
      </div></section>);
  }
}

// WHAT THE PLAYERS' FAUCET GAVE (kanban #926, 2026-11-01: new and returning accounts apart, in the nodes' dashboard): its public totals, no account and no address in
// them. Testnet only; no answer, no card.
export const FAUCET_TOTALS = 'https://bitcoinarena.io/api/faucet/player';
export class FaucetGrants extends React.Component {
  constructor(props) { super(props); this.state = { t: null }; }
  componentDidMount() {
    const read = this.props.read || (() => fetch(FAUCET_TOTALS, { cache: 'no-store' }).then((r) => r.json()));
    Promise.resolve().then(read).then((t) => { if (t && t.ok && !this.gone) this.setState({ t }); }, () => {});
  }
  componentWillUnmount() { this.gone = true; }
  render() {
    const { t } = this.state;
    if (!t) return null;
    const row = (name, p) => <tr key={name}><td>{name}</td><td className="n">{p.accounts.toLocaleString('en-US')}</td><td className="n">{p.grants.toLocaleString('en-US')}</td><td className="n">{p.sats.toLocaleString('en-US')} sat</td><td className="n">{p.today.sats.toLocaleString('en-US')} sat</td></tr>;
    return (
      <section><h2>Test sats given by the faucet</h2><div className="card scroll">
        <table className="tbl"><thead><tr><th>Who</th><th className="n">Accounts</th><th className="n">Grants</th><th className="n">In all</th><th className="n">Today</th></tr></thead>
          <tbody>{row('New accounts', t.newAccounts)}{row('Returning', t.returning)}</tbody></table>
        <p className="sub">{t.totalSats.toLocaleString('en-US')} sat in all. Test sats only, on testnet4.</p>
      </div></section>
    );
  }
}

export class DashboardPage extends React.Component {
  constructor(props) { super(props); this.state = { period: 'day', open: {}, players: {} }; }
  async toggle(id) {
    const open = !this.state.open[id]; const had = this.state.players[id];
    this.setState((s) => ({ open: { ...s.open, [id]: open } }));
    if (!open || (had && !had.error) || !this.props.readResult) return;
    this.setState((s) => ({ players: { ...s.players, [id]: { loading: true } } }));
    let res; try { res = await this.props.readResult(id); } catch (e) { res = { error: e.message }; }
    this.setState((s) => ({ players: { ...s.players, [id]: res } }));
  }
  render() {
    const D = this.props.data;
    if (D.error) return <div className="dash"><h1>Node dashboard</h1><p className="bad">could not read dashboard.json: {D.error}</p></div>;
    const now = D.nowMs; const { period } = this.state;
    const H = D.hosts || {}; const L = H.lnd, G = H.gateway;
    const devs = [...(D.devClient ? [D.devClient] : []), ...(D.devClients || [])];
    const states = Object.entries(D.settlementsByState || {});
    const notes = noteRows(D);
    const hostsRead = Math.max((L && L.readAtMs) || 0, (G && G.readAtMs) || 0);
    return (
      <div className="dash">
        <header className="dash-head">
          <div><h1>Node dashboard{D.release && (D.release.version || D.release.commit) ? <span className="ver" id="release">{D.release.version || String(D.release.commit).slice(0, 8)}</span> : null}</h1>
            {/* THE NODE IN THREE CHIPS (2026-10-26, the owner on "b36828faa1570202… · active since - · 0 rounds checked": "This also looks pretty
                bad, make it more pretty"): its key short with a copy button, since when it checks rounds, how many - words, not "-", while none */}
            <div className="dash-facts">
              <span className="fact" title={String(D.node)}><span className="fact-k">Node</span><code>{String(D.node).slice(0, 8)}…{String(D.node).slice(-6)}</code>
                <CopyButton text={D.node} label="Copy the node key" /></span>
              <span className="fact"><span className="fact-k">Active since</span>{D.sinceMs ? `${short(D.sinceMs, now)} UTC` : <span className="dim">no round checked yet</span>}</span>
              <span className="fact"><span className="fact-k">Rounds checked</span>{Number(D.roundsChecked || 0).toLocaleString('en-US')}</span>
            </div></div>
          <a className="btn" href={ownerHref(D.node, typeof location === 'undefined' ? null : location)}>Owner area →</a>
        </header>
        {/* NO BOND, AT THE TOP (kanban #728): red, with the way to set it up; no founding then (FoundingWait says nothing) */}
        {noBond(D.setup) ? <section><NoBondCard status={D.setup} href={bondHref(D.node, typeof location === 'undefined' ? null : location)} /></section> : null}
        {D.setup && D.setup.ok && D.setup.pegIn && D.setup.pegIn.txid ? <section><PegInCard status={D.setup} /></section> : null}
        {D.setup && D.setup.ok ? <section><SetupStatus status={D.setup} node={D.node} /></section> : null}
        {D.setup && D.setup.ok && D.setup.founding && D.setup.founding.waiting && !noBond(D.setup) ? <section><FoundingWait status={D.setup} /></section> : null}
        {D.capacity ? <section><h2>Capacity</h2><div className="card"><p className={D.capacity.level === 'bad' ? 'bad' : 'warn'}>{String(D.capacity.says)}</p></div></section> : null}
        {/* ITS UPTIME (kanban #756, GET /uptime): 24 h, 7 days, 30 days, all time; the 24 h marked when below inclusion */}
        {D.uptime && Array.isArray(D.uptime.windows) ? <section><h2>Uptime</h2><UptimeStats uptime={D.uptime} /></section> : null}
        <section><h2>Earnings</h2><Earnings totals={D.totals} period={period} onPeriod={(p) => this.setState({ period: p })} /></section>
        <section><div className="card"><Chart days={D.days || []} /></div></section>
        {D.network === undefined || D.network === null || /test/i.test(String(D.network)) ? <FaucetGrants /> : null}
        {devs.length || L || G || (D.byGame || []).length || notes.length ? (
          <section><h2>Money</h2>
            <div className="cards">
              {devs.map((V, i) => <DevClient key={i} client={V} nowMs={now} />)}
              {L || G ? (
                <div className="card"><h3>Hosts</h3>
                  <Rows rows={[...(L ? (L.error ? [['LND', `not read: ${L.error}`]] : [['LND', L.alias], ['Node key', L.pubkey ? `${L.pubkey.slice(0, 16)}…` : null], ['Active channels', L.activeChannels], ['Local / remote', `${sat(L.localMsat)} / ${sat(L.remoteMsat)}`],
                    ['Routing fees, 30 days', `${sat(L.routingFeesMsat30d)} · ${L.forwards30d} forwards`], ['Fees its payments paid', L.paidFeesMsat !== undefined ? `${sat(L.paidFeesMsat)} · ${L.paymentsWithFee} payments` : null]]) : []),
                  ...(G ? (G.error ? [[`Gateway ${G.name}`, `not read: ${G.error}`]] : [['Gateway', `${G.name} · ${G.state}`], ...(G.federations || []).map((f) => [`E-cash in ${f.name || f.id.slice(0, 8)}`, sat(f.ecashMsat)]),
                    ['Lightning balance', G.lightningMsat !== undefined ? sat(G.lightningMsat) : null], ['Inbound liquidity', sat(G.inboundMsat)], ['On-chain', G.onchainSat !== undefined ? `${G.onchainSat} sat` : null],
                    ...(G.payments30d ? [['in', 'incoming'], ['out', 'outgoing']].map(([w, k]) => [`Payments ${w}, 30 days`, `${G.payments30d[k].success} ok · ${G.payments30d[k].failure} failed · fees ${sat(G.payments30d[k].feesMsat)}`]) : [])]) : []),
                  ['Read', hostsRead ? short(hostsRead, now) : null]]} /></div>) : null}
              {(D.byGame || []).length ? (
                <div className="card"><h3>By game</h3>
                  <Rows rows={D.byGame.map((g) => { const owed = g.owed ? earningsOf({ ...g.owed, otherMsat: 0 }).earned : 0n;
                    return [g.name || (g.game ? g.game.slice(0, 12) : '(no game)'), `${g.rounds} round${g.rounds === 1 ? '' : 's'} · ${sat(earningsOf(g.earned || {}).earned)}${owed > 0n ? ` · ${sat(owed)} owed` : ''}`]; })} /></div>) : null}
            </div>
            {notes.length ? <div className="note-strip" id="money-notes">{notes.map(([k, v, full]) => <span key={k} title={full}><b>{k}</b> {keep(v)}</span>)}</div> : null}
          </section>) : null}
        {D.liquidity ? <Liquidity claim={D.liquidity} /> : null}
        <section><h2>Rounds checked</h2>
          <div className="card scroll"><table className="tbl"><thead><tr><th>Round</th><th>Started</th><th>Game</th><th className="n">Entries</th><th className="n">Earned</th><th>Settled</th></tr></thead>
            <tbody>{(D.rounds || []).length ? null : <tr><td colSpan={6} className="sub">No rounds yet. Your node is drawn once it has a bond.</td></tr>}{(D.rounds || []).slice(0, 50).map((r) => {
              const earned = big(r.gameVerifyMsat) + big(r.settlementMsat) + big(r.guardianMsat); const st = r.settlement && r.settlement.state; const isOpen = !!(this.state.open || {})[r.id];
              return (<React.Fragment key={r.id}>
                <tr className="rr" aria-expanded={isOpen ? 'true' : 'false'} onClick={() => this.toggle(r.id)}><td><code>{isOpen ? '▾ ' : '▸ '}{r.id.slice(0, 8)}</code></td><td className="nowrap">{short(r.startMs, now)}</td>
                  <td>{r.gameName || r.game || ''}{r.score ? <span className="sub"> · <b>{r.score.score[0]} : {r.score.score[1]}</b> {r.score.identities.join(' vs ')}</span> : null}{r.kind ? <span className="sub"> · {r.kind}</span> : null}</td>
                  <td className="n">{r.entries}</td><td className="n">{earned > 0n ? sat(earned) : '-'}</td><td className={st === 'ACCEPTED' ? 'ok' : st === 'REFUSED' ? 'bad' : 'sub'}>{st ? st.toLowerCase() : '-'}</td></tr>
                {isOpen ? <tr className="pl"><td colSpan={6}><Players result={(this.state.players || {})[r.id]} /></td></tr> : null}
              </React.Fragment>);
            })}</tbody></table></div></section>
        <section className="two">
          <div><h2>Settlements</h2><div className="card scroll">
            <p className="sub">{states.length ? states.map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ') : 'none yet'}</p>
            <table className="tbl"><tbody>{(D.settlements || []).slice(0, 20).map((s, i) => <tr key={i} title={s.why || undefined}><td><code>{s.round.slice(0, 8)}</code></td><td className="nowrap">{short(s.madeMs, now)}</td><td className={s.state === 'ACCEPTED' ? 'ok' : s.state === 'REFUSED' ? 'bad' : ''}>{String(s.state).toLowerCase()}</td></tr>)}</tbody></table></div></div>
          <div><h2>Federations</h2><div className="card scroll"><table className="tbl"><thead><tr><th>Federation</th><th className="n">Paid rounds</th><th className="n">Last</th></tr></thead>
            <tbody>{(D.federations || []).length ? null : <tr><td colSpan={3} className="sub">No paid rounds in a federation yet.</td></tr>}{(D.federations || []).map((f) => <tr key={f.federation}><td><code>{f.federation.slice(0, 12)}</code></td><td className="n">{f.rounds}</td><td className="n nowrap">{short(f.lastMs, now)}</td></tr>)}</tbody></table></div></div>
        </section>
      </div>);
  }
}
