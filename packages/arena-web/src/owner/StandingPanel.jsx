// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S STANDING, IN REACT (kanban #564): how this node is drawn - draws missed in a row, its bond, its share of all bonds,
// the rounds it qualified for, its bond against the minimum most rounds ask and the network's minimum (a rise with its notice) - and every
// warning in plain words (kanban #553), from GET /owner/seatings and GET /owner/standing. The page's badge is told of missed draws. Below
// them the node's round posting (kanban #702, RoundPosting.jsx).
import React from 'react';
import { RoundPosting } from './RoundPosting.jsx';

/** Each warning kind in the owner's words. */
export const KIND = Object.freeze({ 'missed seatings': 'Missed draws', 'losing brackets': 'Bond below the minimum', 'near the floor': 'Bond at the minimum',
  'falling share': 'Your share is shrinking', 'address changed': 'Address changed' });
const n = (x) => Number(x).toLocaleString('en-US');
const pct = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(1)} %` : '-');
/** The seat's missed-draw warning first, then the standing's. */
export const warningsOf = (seat, st) => [...(seat && seat.warning ? [{ urgent: true, kind: 'missed seatings', says: seat.warning.says, update: seat.warning.update }] : []), ...((st && st.warnings) || [])];

export class StandingPanel extends React.Component {
  constructor(props) { super(props); this.state = { loaded: false, seat: null, standing: null, error: null, ...(props.initial || {}) }; }
  async componentDidMount() {
    if (this.state.loaded || !this.props.api) return;
    try {
      const [seat, standing] = await Promise.all([this.props.api.get('/owner/seatings'), this.props.api.get('/owner/standing')]);
      this.setState({ loaded: true, seat, standing });
      if (seat && seat.warning && this.props.onMissed) this.props.onMissed(seat.missedInARow);
    } catch (e) { this.setState({ loaded: true, error: e.message }); }
  }
  render() {
    const { loaded, seat, standing: st, error } = this.state;
    if (!loaded) return <p className="sub">reading…</p>;
    if (error || !seat || !st) return <p className="err">{error || 'not readable'}</p>;
    const warns = warningsOf(seat, st);
    const min = st.bondMin;
    return (
      <div>
        <div className="row"><span>Draws missed in a row</span><b>{seat.missedInARow}</b></div>
        <div className="row"><span>Bond</span><b>{st.ownBondSats === null ? 'not in the census yet' : `${n(st.ownBondSats)} sat`}</b></div>
        <div className="row"><span>Your share of all bonds</span><b>{pct(st.ownWeight)}</b></div>
        <div className="row"><span>Recent rounds your bond qualified for</span><b>{st.bracketsServed.eligible} of {st.bracketsServed.of}</b></div>
        <div className="row"><span>Bond compared with the minimum most rounds ask</span><b>{typeof st.headroom === 'number' ? `${st.headroom.toFixed(2)}× of ${n(st.commonBondMinSats)} sat` : '-'}</b></div>
        {min && min.inForce !== null ? <div className="row"><span>Network minimum bond now</span><b>{n(min.inForce)} sat{min.pending
          ? ` · rising to ${n(min.pending.value)} sat at block ${min.pending.effectiveAt} if it holds (notice ${min.noticeBlocks} blocks)` : ''}</b></div> : null}
        {warns.length ? warns.map((w, i) => (
          <React.Fragment key={i}>
            <p className={w.urgent ? 'err' : 'sub'}><b>{KIND[w.kind] || w.kind}</b>: {w.says}</p>
            {w.update ? <p className="sub">Step out until it is fixed: <code>{w.update}</code></p> : null}
          </React.Fragment>))
          : <p className="sub ok">No warning: this node shows up when drawn, and its bond is above the safety margin.</p>}
        {/* WHO POSTS THE DAY'S ROUNDS (kanban #702): this node when it is on duty, if its wallet can pay */}
        <RoundPosting api={this.props.api} initial={this.props.initialDuty} />
      </div>
    );
  }
}
