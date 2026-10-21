// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WALLET'S HISTORY IN REACT (kanban #564, the Arena page): every federation's rows as the page's paintHistory drew them - when, what
// (with its federation when there are several), the amount in or out - newest first; a stake that was entered opens its round's replay
// (the page's own handler, `onOpen(row)`, which opens the window on the click itself). The page reads the ledger; this class component
// draws the rows it hands over, or the words when there are none.
import React from 'react';

export class WalletHistory extends React.Component {
  render() {
    const { rows, empty } = this.props;
    if (!rows.length) return <div className="empty">{empty}</div>;
    return rows.map((r) => (
      <div key={r.key} className={`hist-row ${r.plus ? 'plus' : 'minus'}${r.onOpen ? ' clickable' : ''}`} title={r.onOpen ? 'Open this round\'s replay in a new window' : undefined}
        onClick={r.onOpen || undefined}>
        <span className="hist-when">{r.when}</span><span className="hist-what" title={r.what}>{r.what}</span><span className="hist-amt">{r.amt}</span>
      </div>));
  }
}
