// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OTHER WALLETS IN THIS BROWSER IN REACT (kanban #564, the Arena page's Settings): what paintOtherWallets drew by hand into
// #arena-other-wallets - a line while they are read or why they cannot be, then each other kept phrase's wallet with sats in it (or one that
// could not be read now), the total, and "Use this wallet" for one no other open tab holds. Nothing is moved or spent: `onUse(hex)` is the
// page's (this tab takes that phrase and reloads). Wallets with 0 sat are never named (2026-10-02). A class component.
import React from 'react';

export class OtherWallets extends React.Component {
  render() {
    const { note, lines, onUse } = this.props;
    if (note) return note;
    const shown = (lines || []).filter((w) => w.sats !== 0);
    if (!shown.length) return null;
    const total = shown.reduce((t, w) => t + (w.sats || 0), 0);
    return (
      <>
        <div className="muted">{'Other wallets in this browser' + (total ? ': ' + total + ' sat' : '')}</div>
        {shown.map((w) => (
          <div key={w.hex} className="muted">
            {w.hex.slice(0, 8) + '…  ' + (w.sats === null ? 'could not be read now' : w.sats + ' sat') + (w.busy ? '  (open in another tab)' : '  ')}
            {!w.busy && w.sats ? <button type="button" onClick={() => onUse(w.hex)}>Use this wallet</button> : null}
          </div>))}
      </>);
  }
}
