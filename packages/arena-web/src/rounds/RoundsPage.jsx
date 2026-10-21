// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S ROUNDS PAGE IN REACT (kanban #564): what pages/rounds.html draws from /api/rounds - the upcoming rounds with their start,
// end, entry and the committees drawn for them; the finished ones opened one by one for who played and who won (/api/round-result) -
// as stat cards and round cards. A class component; the page keeps its own drawing where this bundle is missing.
import React from 'react';

export const sat = (msat) => `${(BigInt(msat || '0') / 1000n).toLocaleString('en-US')} sat`;
export const short = (hex) => `${String(hex).slice(0, 8)}…${String(hex).slice(-4)}`;
/** The UTC instant as the old page wrote it beside the viewer's own clock. */
export const utcOf = (iso) => String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
/** "in 4 min", "2 h ago" - how far a time is from now. */
export function fromNow(ms, nowMs) {
  const d = ms - nowMs, a = Math.abs(d) / 1000;
  const t = a < 60 ? `${Math.round(a)} s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 172800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
  return d >= 0 ? `in ${t}` : `${t} ago`;
}
/** Players by what they won, then by score - the winners first. */
export function byWin(players) {
  return [...players].sort((a, b) => { const x = BigInt(a.wonMsat || '0'), y = BigInt(b.wonMsat || '0'); return x > y ? -1 : x < y ? 1 : (b.score || 0) - (a.score || 0); });
}
/** The round's entry as a pill: [words, tone]. */
/** Rounds drawn per list at first, and per "Show more" (a seat lists thousands: 2,872 upcoming and 1,569 finished on 10-21). */
export const PAGE = 50;
export const entryOf = (r) => (r.entryOpen ? ['Entry open', 'on'] : r.phase === 'pending' ? ['Pending', 'wait'] : ['Entry closed', null]);

const local = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Game({ r }) {
  const g = r.game;
  return <span className="game">{g && g.icon ? <img src={g.icon} alt="" /> : null}<b>{g ? g.title || g.name : 'Round'}</b><code title={r.id}>{short(r.id)}</code></span>;
}
function Times({ r, nowMs }) {
  return (
    <div className="times">
      <div><span>Start</span><b>{local(r.startTime)}</b><small>{fromNow(Date.parse(r.startTime), nowMs)} · {utcOf(r.startTime)}</small></div>
      <div><span>End</span><b>{local(r.endTime)}</b><small>{utcOf(r.endTime)}</small></div>
    </div>);
}
function Committee({ c }) {
  if (!c || !c.drawn) return <p className="committee"><span className="warn">Committee not drawn</span>{c && c.why ? <span className="dim"> - {c.why}</span> : null}</p>;
  // the counts in one line, the keys when opened (14 keys made every card three times as tall)
  const chips = (list) => list.map((k) => <code key={k} className="chip" title={k}>{short(k)}</code>);
  return (
    <details className="committee">
      <summary>Committee: <b>{c.game.length}</b> game / verify · <b>{c.settlement.length}</b> settlement</summary>
      <div><span className="dim">Game / verify</span>{chips(c.game)}</div>
      <div><span className="dim">Settlement</span>{chips(c.settlement)}</div>
    </details>);
}
const Pill = ({ tone, children }) => <span className={`pill${tone ? ` ${tone}` : ''}`}>{children}</span>;

export function Result({ res }) {
  if (!res) return <p className="dim">reading…</p>;
  if (res.error) return <p className="dim">could not read this round: {res.error}</p>;
  if (!res.players.length) return <p className="dim">nobody played this round</p>;
  return (
    <div className="scroll"><table className="tbl">
      <thead><tr><th>Player</th><th>Outcome</th><th className="n">Score</th><th className="n">Won</th><th>Payout</th></tr></thead>
      <tbody>{byWin(res.players).map((p) => (
        <tr key={p.entry || p.player}>
          <td>{p.name ? <b>{p.name} </b> : null}<code className="dim" title={p.player}>{short(p.player)}</code></td>
          <td>{p.outcome || 'no result'}{p.signedBy ? <span className="dim"> ({p.signedBy} signed)</span> : null}</td>
          <td className="n">{p.score === null || p.score === undefined ? '-' : p.score}</td>
          <td className={`n${BigInt(p.wonMsat || '0') > 0n ? ' won' : ''}`}>{res.free ? '-' : sat(p.wonMsat)}</td>
          <td className="dim">{res.free ? 'free round' : p.winningsState}</td>
        </tr>))}</tbody>
    </table></div>);
}

export class RoundsPage extends React.Component {
  constructor(props) { super(props); this.state = { open: {}, results: {}, shownUp: PAGE, shownFin: PAGE, ...(props.initial || {}) }; }
  more(list, total) {
    const k = list === 'up' ? 'shownUp' : 'shownFin';
    return this.state[k] < total ? <p className="more"><button type="button" className="btn" onClick={() => this.setState((s) => ({ [k]: s[k] + PAGE }))}>Show {Math.min(PAGE, total - this.state[k])} more</button> <span className="dim">{this.state[k]} of {total.toLocaleString('en-US')} shown</span></p> : null;
  }
  async toggle(id) {
    const open = !this.state.open[id];
    this.setState((s) => ({ open: { ...s.open, [id]: open } }));
    if (!open || this.state.results[id]) return;
    let res; try { res = await this.props.readResult(id); } catch (e) { res = { error: e.message }; }
    this.setState((s) => ({ results: { ...s.results, [id]: res } }));
  }
  render() {
    const d = this.props.data;
    if (d.error) return <div className="rounds"><h1>Rounds</h1><p className="bad">could not read this node's rounds: {d.error}</p></div>;
    const nowMs = Number(d.nowMs);
    const up = [...d.upcoming].sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    const open = up.filter((r) => r.entryOpen).length;
    const played = d.finished.reduce((t, r) => t + (Number(r.joined) || 0), 0);
    return (
      <div className="rounds">
        <h1>Rounds</h1>
        <p className="sub">node <code>{d.node}</code> · read {new Date(nowMs).toLocaleTimeString()}</p>
        <div className="stats">
          <div className="stat"><span>Upcoming</span><b>{up.length}</b><small>{!up.length ? 'no round announced' : Date.parse(up[0].startTime) <= nowMs ? `first started ${fromNow(Date.parse(up[0].startTime), nowMs)}` : `next ${fromNow(Date.parse(up[0].startTime), nowMs)}`}</small></div>
          <div className="stat"><span>Entry open</span><b className={open ? 'ok' : ''}>{open}</b><small>{open ? 'join now' : 'none open right now'}</small></div>
          <div className="stat"><span>Finished</span><b>{d.finished.length}</b><small>{played} {played === 1 ? 'entry' : 'entries'}</small></div>
        </div>
        <h2>Upcoming <span className="dim">({up.length})</span></h2>
        {up.length ? <div className="cards">{up.slice(0, this.state.shownUp).map((r) => { const [w, tone] = entryOf(r); return (
          <div key={r.id} className="card round">
            <div className="card-head"><Game r={r} /><span><Pill tone={tone}>{w}</Pill><Pill>{r.free ? 'free' : `stake ${sat(r.stakeMsat)}`}</Pill></span></div>
            <Times r={r} nowMs={nowMs} />
            <Committee c={r.committee} />
          </div>); })}</div> : <p className="empty">no round announced</p>}
        {this.more('up', up.length)}
        <h2>Finished <span className="dim">({d.finished.length})</span></h2>
        {d.finished.length ? <div className="list">{d.finished.slice(0, this.state.shownFin).map((r) => { const isOpen = !!this.state.open[r.id]; return (
          <div key={r.id} className={`card round fin${isOpen ? ' open' : ''}`}>
            <button type="button" className="head" aria-expanded={isOpen ? 'true' : 'false'} onClick={() => this.toggle(r.id)}>
              <div className="card-head"><Game r={r} /><span><Pill>{r.free ? 'free' : `stake ${sat(r.stakeMsat)}`}</Pill><Pill>{r.joined} joined</Pill><i className="chev">{isOpen ? '▾' : '▸'}</i></span></div>
              <Times r={r} nowMs={nowMs} />
            </button>
            {isOpen ? <div className="acc"><Committee c={r.committee} /><Result res={this.state.results[r.id]} /></div> : null}
          </div>); })}</div> : <p className="empty">no round finished yet</p>}
        {this.more('fin', d.finished.length)}
      </div>);
  }
}
