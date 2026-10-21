// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S OVERVIEW: WHAT NEEDS THE OWNER, IN REACT (kanban #564): every section tells the page what needs the owner (the
// page's need(): a missed draw, a service down, a new release, a bond too low) - here the list, the urgent first, each with a link to its
// section; or that nothing needs them.
import React from 'react';

/** Urgent ('bad') first, then the warnings, each kept in the order it came. */
export const ordered = (items) => [...(items || [])].sort((x, y) => (x.level === 'bad' ? 0 : 1) - (y.level === 'bad' ? 0 : 1));

export class NeedsPanel extends React.Component {
  render() {
    const list = ordered(this.props.items);
    if (!list.length) return <div><h3 className="ok">Nothing needs you ✓</h3><p className="sub">This node runs, its bond is enough and it is up to date.</p></div>;
    return (
      <div>
        <h3>What needs you</h3>
        {list.map((n, i) => <p key={i} className={n.level === 'bad' ? 'err' : 'warnline'}>{n.level === 'bad' ? '🔴' : '🟡'} {n.text} <a href={`#${n.section}`}>Open</a></p>)}
      </div>);
  }
}
