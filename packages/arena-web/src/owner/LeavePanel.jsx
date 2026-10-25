// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LEAVE WITHOUT BEING SLASHED, IN REACT (kanban #564): what owner.html's leavePanel() drew by hand. From the moment the owner signs Leave this
// seat takes no new round and serves the ones it holds to their end; it is free once the last is past its objection window and settled.
// Custody: only if the federation keeps its threshold without this guardian. WHEN THE BOND IS FREE (kanban #553, 2026-10-20: "his
// bond will not immediatly be released, be sure to display the number of blocks left AND the estimated times in days and hours"): the
// bond's lock - its maturity block - is the rule, the time an estimate. The page reads the seat and hands over `leave` (GET /owner/leave),
// `bond` (GET /owner/bond, null when it did not answer), `why` (when the leave state could not be read) and `act('leave' | 'stay')`.
import React from 'react';
import { daysHours } from './BondOffer.jsx';

const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const n = (x) => Number(x).toLocaleString('en-US');

export class LeavePanel extends React.Component {
  constructor(props) { super(props); this.state = { ok: false, err: '' }; }
  async act(action) {
    this.setState({ err: '' });
    try { await this.props.act(action); } catch (e) { this.setState({ err: e.message }); }
  }
  render() {
    const { leave: st, bond: b, why } = this.props;
    if (why) return <p className="err">{why}</p>;
    const free = st.freeNow ? 'now' : st.freeAtMs ? when(st.freeAtMs) : 'once its last paying round is paid out';
    const l = b && b.lock;
    const bondLine = !b || !b.bond ? 'This node has no bond in the census.'
      : !l ? 'Its lock is shown once this node reads the chain.'
      : l.withdrawable ? `Your bond is already unlocked (since block ${l.maturity}): you can withdraw it in the Bond section once this node has left.`
      : <>Your bond stays locked until block <b>{String(l.maturity)}</b>: <b>{n(l.blocksLeft)} blocks</b> from now, about <b>{daysHours(l.estimatedMs - Date.now())}</b> (around {when(l.estimatedMs)}). Leaving does not shorten this.</>;
    const err = <div className="err" id="lerr">{this.state.err}</div>;
    if (st.leaving) return (
      <>
        <p className="answer"><b>This node is leaving</b> (since {when(st.leavingAtMs)}).</p>
        <div className="row"><span>Rounds it still finishes</span><b>{String(st.owed)}</b></div>
        <div className="row"><span>Free to switch off</span><b>{free}</b></div>
        <p>{bondLine}</p>
        {err}<button type="button" id="stay" onClick={() => this.act('stay')}>Stay: take rounds again</button>
      </>);
    const blocked = st.custody.guardian && !st.custody.allowed;
    return (
      <>
        <p>Leaving takes this node out of the network for good. It finishes the rounds it already holds, so nobody loses a round, and you are never penalised for leaving.</p>
        <div className="warn"><b>Before you leave:</b>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            <li>From now on this node takes no new rounds and earns no new fees.</li>
            <li><b>Your bond is not paid back at once.</b> {bondLine}</li>
            <li>Keep the node running until it has finished its rounds ({String(st.owed)} now; free to switch off {free}).</li>
            {st.custody.guardian ? <li>It holds custody: {st.custody.allowed ? 'its federation keeps enough guardians without it, so it may leave.' : <b>its federation would not keep enough guardians without it, so it may not leave yet.</b>}</li> : null}
          </ul></div>
        <label className="confirm"><input type="checkbox" id="lok" checked={this.state.ok} onChange={(e) => this.setState({ ok: e.target.checked })} /> <span>I understand: this node stops taking rounds for good{!l ? '.' : l.withdrawable
          ? ', and I withdraw my bond myself (Bond section) once it has finished its rounds.' : `, and my bond stays locked until block ${l.maturity} - ${n(l.blocksLeft)} blocks, about ${daysHours(l.estimatedMs - Date.now())}.`}</span></label>
        {err}<button type="button" className="primary" id="go" disabled={!this.state.ok || blocked} onClick={() => this.act('leave')}>Leave the network</button>
      </>);
  }
}
