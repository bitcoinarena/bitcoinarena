// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE DASHBOARD, IN REACT (kanban #566, the owner 2026-10-21: "this looks very off and doesn't even fit. Make it look much more modern,
// the entire page as well"): the same /dashboard.json drawn as cards that size to their content - what the node earned in the period
// chosen as one large number with its roles as a bar, what it is owed, its profit; the 30 days as a stacked chart; the dev clients
// each in a card whose table fits (short dates, one line each); the hosts and the games; the rounds, settlements and federations as
// tables that scroll inside their card. Empty rows are left out; nothing runs past its card on a desktop or a phone.
import React from 'react';

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
        <div className="seg" role="tablist">{Object.entries(PERIOD).map(([p, name]) => (
          <button key={p} type="button" role="tab" aria-selected={p === period} className={p === period ? 'on' : undefined} onClick={() => onPeriod(p)}>{name}</button>))}</div>
        <div className="stats">
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
        <svg viewBox={`0 0 ${W} ${H + 20}`} role="img" aria-label="fees earned per day" onPointerLeave={() => this.setState({ at: null })}>
          {days.map((d, i) => {
            let y = H; const x = P + i * bw + 2, w = Math.max(1, bw - 4);
            const parts = [['gameVerifyMsat', 'var(--gv)'], ['settlementMsat', 'var(--st)'], ['guardianMsat', 'var(--gd)']].map(([k, c]) => { const h = (H - 6) * Number(d[k]) / max; y -= h; return <rect key={k} x={x} y={y} width={w} height={h} fill={c} rx="2" />; });
            return (
              <g key={d.day} onPointerEnter={() => this.setState({ at: i })} onPointerDown={() => this.setState({ at: i })}>
                <rect x={x - 2} y="0" width={bw} height={H} fill={this.state.at === i ? 'rgba(127,127,127,.12)' : 'transparent'} />{parts}
                {i % 5 === 0 ? <text x={x} y={H + 16} fill="var(--dim)" fontSize="13">{d.day.slice(5)}</text> : null}</g>);
          })}
        </svg>
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
          ['Last pass', V.lastPass ? `${short(Date.parse(V.lastPass.at), now)} · asked ${V.lastPass.seats} nodes${V.lastPass.unanswered ? ` (${V.lastPass.unanswered} unanswered)` : ''}` : null]]} />
        {(V.recent || []).length ? (
          <div className="scroll"><table className="tbl"><thead><tr><th>Round</th><th>Federation</th><th className="n">Donation</th><th className="n">When</th></tr></thead>
            <tbody>{V.recent.map((x, i) => <tr key={i}><td><code>{x.round.slice(0, 8)}</code></td><td><code>{x.federation.slice(0, 8)}</code></td><td className="n">{sat(x.amountMsat)}</td><td className="n nowrap">{short(x.atMs, now)}</td></tr>)}</tbody></table></div>) : null}
      </div>);
  }
}

export class DashboardPage extends React.Component {
  constructor(props) { super(props); this.state = { period: 'day' }; }
  render() {
    const D = this.props.data; const now = D.nowMs; const { period } = this.state;
    const H = D.hosts || {}; const L = H.lnd, G = H.gateway;
    const devs = [...(D.devClient ? [D.devClient] : []), ...(D.devClients || [])];
    const states = Object.entries(D.settlementsByState || {});
    return (
      <div className="dash">
        <header className="dash-head">
          <div><h1>Node dashboard</h1><p className="sub"><code>{String(D.node).slice(0, 16)}…</code> · active since {short(D.sinceMs, now)} · {D.roundsChecked} rounds checked</p></div>
          <a className="btn" href="Dashboard/owner">Owner area →</a>
        </header>
        <section><h2>Earnings</h2><Earnings totals={D.totals} period={period} onPeriod={(p) => this.setState({ period: p })} /></section>
        <section><div className="card"><Chart days={D.days || []} /></div></section>
        {devs.length || L || G || (D.byGame || []).length ? (
          <section><h2>Money around this node</h2>
            <div className="cards">
              {devs.map((V, i) => <DevClient key={i} client={V} nowMs={now} />)}
              {L || G ? (
                <div className="card"><h3>Hosts</h3>
                  <Rows rows={[...(L ? (L.error ? [['LND', `not read: ${L.error}`]] : [['LND', L.alias], ['Active channels', L.activeChannels], ['Local / remote', `${sat(L.localMsat)} / ${sat(L.remoteMsat)}`],
                    ['Routing fees, 30 days', `${sat(L.routingFeesMsat30d)} · ${L.forwards30d} forwards`]]) : []),
                  ...(G ? (G.error ? [[`Gateway ${G.name}`, `not read: ${G.error}`]] : [['Gateway', `${G.name} · ${G.state}`], ...(G.federations || []).map((f) => [`E-cash in ${f.name || f.id.slice(0, 8)}`, sat(f.ecashMsat)]),
                    ['Inbound liquidity', sat(G.inboundMsat)]]) : [])]} /></div>) : null}
              {(D.byGame || []).length ? (
                <div className="card"><h3>By game</h3>
                  <Rows rows={D.byGame.map((g) => [g.name || (g.game ? g.game.slice(0, 12) : '(no game)'), `${g.rounds} round${g.rounds === 1 ? '' : 's'} · ${sat(earningsOf(g.earned || {}).earned)}`])} /></div>) : null}
            </div>
          </section>) : null}
        <section><h2>Rounds checked</h2>
          <div className="card scroll"><table className="tbl"><thead><tr><th>Round</th><th>Started</th><th>Game</th><th className="n">Entries</th><th className="n">Earned</th><th>Settled</th></tr></thead>
            <tbody>{(D.rounds || []).slice(0, 50).map((r) => {
              const earned = big(r.gameVerifyMsat) + big(r.settlementMsat) + big(r.guardianMsat); const st = r.settlement && r.settlement.state;
              return <tr key={r.id}><td><code>{r.id.slice(0, 8)}</code></td><td className="nowrap">{short(r.startMs, now)}</td><td>{r.gameName || r.game || ''}</td><td className="n">{r.entries}</td><td className="n">{earned > 0n ? sat(earned) : '-'}</td><td className={st === 'ACCEPTED' ? 'ok' : st === 'REFUSED' ? 'bad' : 'sub'}>{st ? st.toLowerCase() : '-'}</td></tr>;
            })}</tbody></table></div></section>
        <section className="two">
          <div><h2>Settlements</h2><div className="card scroll">
            <p className="sub">{states.length ? states.map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ') : 'none yet'}</p>
            <table className="tbl"><tbody>{(D.settlements || []).slice(0, 20).map((s, i) => <tr key={i}><td><code>{s.round.slice(0, 8)}</code></td><td className="nowrap">{short(s.madeMs, now)}</td><td className={s.state === 'ACCEPTED' ? 'ok' : s.state === 'REFUSED' ? 'bad' : ''}>{String(s.state).toLowerCase()}</td></tr>)}</tbody></table></div></div>
          <div><h2>Federations</h2><div className="card scroll"><table className="tbl"><thead><tr><th>Federation</th><th className="n">Paid rounds</th><th className="n">Last</th></tr></thead>
            <tbody>{(D.federations || []).map((f) => <tr key={f.federation}><td><code>{f.federation.slice(0, 12)}</code></td><td className="n">{f.rounds}</td><td className="n nowrap">{short(f.lastMs, now)}</td></tr>)}</tbody></table></div></div>
        </section>
      </div>);
  }
}
