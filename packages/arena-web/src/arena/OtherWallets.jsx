// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OTHER WALLETS IN THIS BROWSER IN REACT (kanban #564, the Wallet's Federations tab since #631): the other phrases kept here with a
// wallet in a federation, how each federation's merge into this wallet stands (merged, merging, waiting and why), the sats already on their
// way, and "Merge now", which runs the merge in those federations (the page's `onMerge(federations)`). Kanban #631, 2026-10-24:
// "Other wallets in the browser, rework that, ok the lobby makes no sense, not all apps even have a lobby, find better ways to restore
// funds": no lobby is needed, and the money comes over with one tap. Nothing here opens a wallet. A class component.
import React from 'react';

const sat = (n) => Number(n).toLocaleString('en-US') + ' sat';
const STATE = { merging: 'merging …', merged: 'merged', stuck: 'waiting' };

export class OtherWallets extends React.Component {
  render() {
    const { wallets, feds, onMerge, merging, mergingSats } = this.props;
    if (!(wallets || []).length && !(feds || []).some((f) => f.onWaySats)) return null;
    const waiting = (feds || []).find((f) => f.merge && f.merge.state === 'stuck' && f.merge.why);
    return (
      <div className="ow">
        <div className="ow-head">Other wallets in this browser</div>
        {(wallets || []).map((w) => (
          <div key={w.hex} className="ow-id">Wallet {w.hex.slice(0, 8)}…{w.busy ? <span className="muted"> · open in another tab - close it to merge</span> : null}</div>))}
        {(feds || []).map((f) => (
          <div key={f.federation} className="ow-row">
            <span className="mono">{f.federation.slice(0, 8)}…</span>
            <span>{f.onWaySats ? sat(f.onWaySats) + ' on its way' : ''}</span>
            <span className="muted">{f.merge ? STATE[f.merge.state] || f.merge.state : 'not merged yet'}</span>
          </div>))}
        {mergingSats ? <div className="muted ow-why">{sat(mergingSats)} merging into this wallet now.</div> : null}
        {waiting ? <div className="muted ow-why">{waiting.merge.why}</div> : null}
        {(feds || []).length ? <button type="button" className="ow-merge" disabled={!!merging} onClick={() => onMerge(feds.map((f) => f.federation))}>
          {merging ? 'Merging …' : 'Merge now into this wallet'}</button> : null}
        <div className="muted ow-why">Merging moves their sats into this wallet, in the same federations.</div>
      </div>);
  }
}
