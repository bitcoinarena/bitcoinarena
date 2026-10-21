// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// "YOUR BALANCE" BY FEDERATION IN REACT (kanban #564, the Arena page): what the page's paintSplit drew - the head (its close hidden inside
// the Wallet), each federation with its sats, its health dot and word (with its load) and the note under it (a HALTED one's payback), the
// words when there is none, and the total with what is arriving or pending. The page reads the balance, the federations' records and the
// chain; it hands this class component the rows. DEBUG (kanban #545, Advanced settings' toggle): every federation the page read - its status
// and load, reserve against cap and the room left, a HALTED one's payback - and "Deposit here" into exactly that one (`onDeposit`).
import React from 'react';

export class BalanceSplit extends React.Component {
  render() {
    const { title, closable, onClose, rows, empty, total, debug } = this.props;
    return (
      <>
        <div className="ov-head"><h4>{title}</h4><button type="button" className="ov-close" title="Close" hidden={!closable} onClick={(e) => { e.stopPropagation(); onClose(); }}>{'×'}</button></div>
        {empty ? <div className="row">{empty}</div> : null}
        {rows.map((r) => (
          <div key={r.federation} className="row">
            <div>
              <div className="fed">{`Federation ${r.federation.slice(0, 8)}…`}</div>
              <div className="st"><span className={`hl ${r.level}`} />{r.label}</div>
              {r.note ? <div className={`note${r.level === 'bad' ? ' bad' : ''}`}>{r.note}</div> : null}
            </div>
            <b>{r.value}</b>
          </div>))}
        {total ? <div className="row total"><div>{total.label}</div><b>{total.value}</b></div> : null}
        {debug ? <>
          <div className="dbg-h">{`All federations (debug) \u00b7 ${debug.rows.length}`}</div>
          {debug.rows.length ? null : <div className="row">No federation record read yet</div>}
          {debug.rows.map((r) => (
            <div key={r.federation} className="row">
              <div>
                <div className="fed">{`Federation ${r.federation.slice(0, 8)}\u2026`}</div>
                <div className="st"><span className={`hl ${r.level}`} />{r.state}</div>
                <div className="dbg-cap">{r.cap}</div>
                {r.note ? <div className="note bad">{r.note}</div> : null}
              </div>
              <button type="button" className="dep-here" disabled={!r.canDeposit} title={r.canDeposit ? undefined : 'its record names no invite'}
                onClick={(e) => { e.stopPropagation(); r.onDeposit(); }}>Deposit here</button>
            </div>))}
        </> : null}
      </>);
  }
}
