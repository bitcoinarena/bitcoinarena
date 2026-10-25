// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WALLET'S HISTORY IN REACT (kanban #564, the Arena page): every federation's rows as the page's paintHistory drew them - when, what
// (with its federation when there are several), the amount in or out - newest first; a stake that was entered opens its round's replay
// (the page's own handler, `onOpen(row)`, which opens the window on the click itself). The page reads the ledger; this class component
// draws the rows it hands over, or the words when there are none; a slow order's row says so, with its log to copy. A row of an order names its transaction, short, linked to the explorer
// in a new window (2026-10-24: "Die UI braucht die tx ids, stark verkürzt mit link zum Explorer (in a new window)").
import React from 'react';

/** A SLOW ORDER (2026-10-24: "Store the client log for delayed orders locally with a button copy log and a label slow tx"): its time and the
 *  page's log of it, kept in this browser, copied on a press. */
function SlowTx({ slow }) {
  const [said, setSaid] = React.useState('');
  return (<span className="hist-slow" onClick={(e) => e.stopPropagation()}><b>slow tx</b> <span>{(slow.ms / 1000).toFixed(1)} s</span>
    <button type="button" onClick={async () => setSaid((await slow.copy()) ? 'copied' : 'copy failed')}>Copy log</button>{said ? <span>{said}</span> : null}</span>);
}

export class WalletHistory extends React.Component {
  render() {
    const { rows, empty } = this.props;
    if (!rows.length) return <div className="empty">{empty}</div>;
    return rows.map((r) => (
      <div key={r.key} className={`hist-row ${r.plus ? 'plus' : 'minus'}${r.onOpen ? ' clickable' : ''}`} title={r.onOpen ? 'Open this round\'s replay in a new window' : undefined}
        onClick={r.onOpen || undefined}>
        <span className="hist-when">{r.when}</span><span className="hist-what" title={r.what}>{r.what}</span>
        {/^[0-9a-f]{64}$/.test(String(r.tx || '')) ? <a className="hist-tx" href={'https://explorer.bitcoin-arena.io/tx/' + r.tx + (r.txAnchor || '')} target="_blank" rel="noopener noreferrer"
          title={'Transaction ' + r.tx + ' in the explorer'} onClick={(e) => e.stopPropagation()}>tx {r.tx.slice(0, 6)}…</a> : <span className="hist-tx" />}
        <span className="hist-amt">{r.amt}</span>
        {r.slow ? <SlowTx slow={r.slow} /> : null}
      </div>));
  }
}
