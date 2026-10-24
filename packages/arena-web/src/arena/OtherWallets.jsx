// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OTHER WALLETS IN THIS BROWSER IN REACT (kanban #564, the Wallet's Federations tab since #631): each other kept phrase's wallet with
// sats in it, by federation - what it holds there and how its merge into this wallet stands - and "Merge now", which moves those sats into
// this wallet in the same federations (the page's `onMerge(federations)`). Kanban #631, the owner 2026-10-24: "Other wallets in the browser,
// rework that, ok the lobby makes no sense, not all apps even have a lobby, find better ways to restore funds": no lobby is needed to read
// them, and the money comes over with one tap. Wallets with 0 sat are never named (2026-10-02). A class component.
import React from 'react';

const sat = (n) => Number(n).toLocaleString('en-US') + ' sat';
const MERGE_WORDS = { merging: 'merging …', merged: 'merged', stuck: 'not merged yet' };

export class OtherWallets extends React.Component {
  render() {
    const { note, wallets, onMerge, merging } = this.props;
    if (note) return <div className="ow"><div className="ow-head">Other wallets in this browser</div><div className="muted">{note}</div></div>;
    const shown = (wallets || []).filter((w) => w.feds.some((f) => f.sats !== 0));
    if (!shown.length) return null;
    const total = shown.reduce((t, w) => t + w.feds.reduce((a, f) => a + (f.sats || 0), 0), 0);
    const feds = [...new Set(shown.flatMap((w) => w.feds.filter((f) => f.sats).map((f) => f.federation)))];
    return (
      <div className="ow">
        <div className="ow-head">Other wallets in this browser{total ? ': ' + sat(total) : ''}</div>
        {shown.map((w) => (
          <div key={w.hex} className="ow-wallet">
            <div className="ow-id">Wallet {w.hex.slice(0, 8)}…{w.busy ? <span className="muted"> · open in another tab - close it to merge</span> : null}</div>
            {w.feds.filter((f) => f.sats !== 0).map((f) => (
              <div key={f.federation} className="ow-row">
                <span className="mono">{f.federation.slice(0, 8)}…</span>
                <span>{f.sats === null ? 'could not be read now' : sat(f.sats)}</span>
                <span className="muted" title={f.merge && f.merge.why ? f.merge.why : undefined}>{f.merge ? MERGE_WORDS[f.merge.state] || f.merge.state : ''}</span>
              </div>))}
          </div>))}
        {feds.length ? <button type="button" className="ow-merge" disabled={!!merging} onClick={() => onMerge(feds)}>
          {merging ? 'Merging …' : 'Merge now into this wallet'}</button> : null}
        <div className="muted ow-why">Merging moves these sats into this wallet, in the same federations.</div>
      </div>);
  }
}
