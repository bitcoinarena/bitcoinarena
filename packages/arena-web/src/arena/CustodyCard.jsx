// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WALLET'S FEDERATIONS BOX IN REACT (kanban #564, the Arena page): what the page's paintCustody drew - the head, one line per value in
// its own colour with its tip, and the health as a pill in the band's colour. The page reads the census and the federations' records and
// tints the box by its band; this class component draws the lines it hands over.
import React from 'react';

export class CustodyCard extends React.Component {
  render() {
    const { rows } = this.props;
    return (
      <>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#f7931a', marginBottom: 4 }}>{'🏦 Federations'}</div>
        {rows.map((r) => (
          <div key={r.k} title={r.tip || undefined} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '1px 0', cursor: r.tip ? 'help' : undefined }}>
            <span style={{ color: '#a9b3c1' }}>{r.k}</span>
            <b title={r.pill ? r.tip : undefined} style={r.pill ? { fontWeight: 700, color: '#0d1117', background: r.pill, borderRadius: 999, padding: '1px 10px' } : { fontWeight: 700, color: r.color || '#e6edf5' }}>{r.v}</b>
          </div>))}
      </>);
  }
}
