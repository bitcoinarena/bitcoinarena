// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PREDICTION MARKET'S VIEWS, IN REACT (kanban #564, the market slice): what the page shows, drawn from what btc-updown's market.js
// already computes - pickSheet() for the sheet (the outcomes, the stake, the fees and when they are due, what is at risk, who decides the
// outcome, the confirmation an unlisted market needs) and marketLines() for the player's orders (open with the time left, waiting for its
// attestors, void, disputed, unverified, won or lost, and the objection window before a result is final). The logic stays market.js's;
// these classes only draw it.
import React from 'react';
import { Button } from '../design/components.jsx';

/** The pick sheet: `sheet` = market.js pickSheet(...); onPick(index, confirmed); onClose. */
export class PickSheet extends React.Component {
  constructor(props) { super(props); this.state = { confirmed: false }; }
  render() {
    const { sheet, onPick, onClose, busy = false } = this.props;
    const needs = !!sheet.confirm;
    const ok = !needs || this.state.confirmed;
    return (
      <div className="sheet" role="dialog" aria-label={sheet.title}>
        <h3>{sheet.title}</h3>
        <div className="picks">
          {sheet.outcomes.map((o) => <Button key={o.index} primary disabled={!ok || busy} onClick={() => onPick && onPick(o.index, this.state.confirmed)}>{o.label}</Button>)}
        </div>
        <p>{sheet.lines.stake}</p>
        <p className="sub">{sheet.lines.fee}</p>
        <p><b>{sheet.lines.net}</b></p>
        <p className="sub">{sheet.attestors}</p>
        {needs ? <label className="confirm"><input type="checkbox" checked={this.state.confirmed} onChange={(e) => this.setState({ confirmed: e.target.checked })} /> <span>{sheet.confirm}</span></label> : null}
        {onClose ? <Button onClick={onClose}>Close</Button> : null}
      </div>
    );
  }
}

/** A line's state as the player reads it, and its tone. */
export const STATE_LABEL = Object.freeze({ open: ['Open', 'wait'], waiting: ['Waiting for the result', null], void: ['Void - refunded', null], disputed: ['Disputed', 'bad'],
  unverified: ['Unverified', 'bad'], won: ['Won', 'on'], lost: ['Lost', null], refunded: ['Refunded', null], settled: ['Settled', 'on'], unknown: ['Unknown', null] });

/** The player's orders: `lines` = market.js marketLines(...). Each a row - the market, the pick, the stake, a state pill, its text. */
export class MarketLines extends React.Component {
  render() {
    const { lines = [], nowMs = Date.now() } = this.props;
    if (!lines.length) return <p className="sub">No orders yet.</p>;
    return (
      <div className="market-lines">
        {lines.map((l, i) => {
          const [label, tone] = STATE_LABEL[l.state] || [l.state, null];
          const pending = l.final === false && l.finalAtMs ? Math.max(0, Math.ceil((l.finalAtMs - nowMs) / 60000)) : null;
          return (
            <div key={`${l.round || i}:${l.entry || ''}`} className="row market-line">
              <span>{l.label ? <b>{l.label}</b> : null} <span className="sub">{l.text}</span></span>
              <b><span className={`pill${tone ? ` ${tone}` : ''}`}>{label}{pending !== null ? ` · final in ${pending} min` : ''}</span></b>
            </div>);
        })}
      </div>
    );
  }
}
