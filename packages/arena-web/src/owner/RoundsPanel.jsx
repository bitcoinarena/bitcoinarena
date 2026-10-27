// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER AREA'S ROUNDS (kanban #715): the rounds this node is drawn for - coming, running and of the last day - with what it does in
// each ("Play and check", "Pay out winners", a reserve), and when there is none the reason in plain words (GET /owner/rounds,
// owner-rounds.js). Read again every minute while the section is open.
import React from 'react';

const at = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const PHASE = { upcoming: 'coming', running: 'running', done: 'done' };

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
    return (
      <div>
        {data.why ? <div className="note-strip" id="rounds-why"><b>No rounds for this node right now.</b> {data.why.says}</div> : null}
        {rounds.length ? <>
          <p className="sub">{data.upcoming ? `${data.upcoming} coming or running. ` : ''}Drawn rounds of the last day and the coming ones.</p>
          <table className="rounds" id="rounds-list"><thead><tr><th>When</th><th>Game</th><th>This node</th><th></th></tr></thead><tbody>
            {rounds.slice(0, 40).map((r) => (
              <tr key={r.round} className={r.phase}>
                <td>{day(r.startMs)} {at(r.startMs)}</td>
                <td>{r.game ? `${r.game.title || r.game.name}${r.game.version ? ` v${r.game.version}` : ''}` : 'a game this node does not host'}{r.paid === false ? ' · free' : ''}</td>
                <td>{(r.does || []).join(' · ')}</td>
                <td><span className={`pill ${r.phase === 'running' ? 'on' : r.phase === 'upcoming' ? 'wait' : ''}`}>{PHASE[r.phase] || r.phase}</span></td>
              </tr>))}
          </tbody></table></> : (data.why ? null : <p className="sub">No rounds yet.</p>)}
      </div>);
  }
}
