// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER AREA'S ROUNDS (kanban #715): the rounds this node is drawn for - coming, running and of the last day - with what it does in
// each ("Play and check", "Pay out winners", a reserve), and when there is none the reason in plain words (GET /owner/rounds,
// owner-rounds.js). Read again every minute while the section is open.
import React from 'react';

const at = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const PHASE = { upcoming: 'coming', running: 'running', done: 'done' };
// A PAID ROUND'S STAKE AGAINST ITS CEILING (§5A.10, kanban #1282): both bounds, which one binds, and whether it is enforced on this network
const n = (x) => Number(x || 0).toLocaleString('en-US');
export function ceilingLine(x) {
  const bounds = `census table ${n(x.tableCeilingSats)} sat${x.incomeSeatSats !== null && x.incomeSeatSats !== undefined ? `, one seat's season income ${n(x.incomeSeatSats)} sat` : ''}`;
  return `stake ${n(x.stakeSats)} of a ceiling of ${n(x.ceilingSats)} sat (${bounds}; the ${x.binds === 'income' ? 'income' : 'table'} binds)`
    + (x.ok ? '' : x.enforced ? ' - above it: refused' : ' - above it: shown only, not enforced on a test network');
}

export class RoundsPanel extends React.Component {
  constructor(props) { super(props); this.state = { loaded: false, data: null, error: null, ...(props.initial || {}) }; }
  async componentDidMount() {
    if (!this.props.api) return;
    if (!this.state.loaded) await this.load();
    this.timer = setInterval(() => this.load(), this.props.everyMs || 60000);
  }
  componentWillUnmount() { clearInterval(this.timer); }
  async load() {
    try { this.setState({ loaded: true, data: await this.props.api.get('/owner/rounds'), error: null }); }
    catch (e) { this.setState({ loaded: true, error: e.message }); }
  }
  render() {
    const { loaded, data, error } = this.state;
    if (!loaded) return <p className="sub">reading this node's rounds…</p>;
    if (error || !data) return <p className="warn">Couldn't read the rounds{error ? `: ${error}` : ''}. The node may be restarting.</p>;
    const rounds = data.rounds || [];
    const audit = data.audit;
    const sats = (msat) => Math.floor(Number(msat || 0) / 1000).toLocaleString('en-US');
    return (
      <div>
        {audit ? <p className="sub" id="rounds-audit">As an auditor: {audit.audited} round{audit.audited === 1 ? '' : 's'} audited, {audit.objections} objection{audit.objections === 1 ? '' : 's'} filed, {sats(audit.earnedMsat)} sats earned{audit.unread ? ` so far (${audit.unread} still being read)` : ''}.</p> : null}
        {data.why ? <div className="note-strip" id="rounds-why"><b>No rounds for this node right now.</b> {data.why.says}</div> : null}
        {rounds.length ? <>
          <p className="sub">{data.upcoming ? `${data.upcoming} coming or running. ` : ''}Drawn rounds of the last day and the coming ones.</p>
          <table className="rounds" id="rounds-list"><thead><tr><th>When</th><th>Game</th><th>This node</th><th></th></tr></thead><tbody>
            {rounds.slice(0, 40).map((r) => (
              <tr key={r.round} className={r.phase}>
                <td>{day(r.startMs)} {at(r.startMs)}</td>
                <td>{r.game ? `${r.game.title || r.game.name}${r.game.version ? ` v${r.game.version}` : ''}` : 'a game this node does not host'}{r.paid === false ? ' · free' : ''}
                  {r.ceiling ? <div className={`sub ceiling${r.ceiling.ok ? '' : ' warn'}`}>{ceilingLine(r.ceiling)}</div> : null}</td>
                <td>{(r.does || []).join(' · ')}</td>
                <td><span className={`pill ${r.phase === 'running' ? 'on' : r.phase === 'upcoming' ? 'wait' : ''}`}>{PHASE[r.phase] || r.phase}</span></td>
              </tr>))}
          </tbody></table></> : (data.why ? null : <p className="sub">No rounds yet.</p>)}
      </div>);
  }
}
