// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TILE'S CHIP LIST IN REACT (kanban #564, the Arena page): the nodes, open rounds or players of one game, as the page's ARENA_CHIP_LIST
// drew them - notes, the role legend, and rows (a title, a line under it, the node's role icons with their words, the nodes assigned to a
// round, and a link or a tag on the right). The page still asks the nodes; it hands this class component the blocks it would have drawn.
// The four role icons are the page's own fixed SVGs.
import React from 'react';

export const ROLE_KEYS = ['verify', 'settlement', 'custody', 'liquidity'];
const Icon = ({ svg }) => <span className="ic" dangerouslySetInnerHTML={{ __html: svg }} />;

function Row({ r, icons, words }) {
  return (
    <div className="row">
      <div className="main">
        <div className="t">{r.t}</div>
        {r.s ? <div className="s">{r.s}</div> : null}
        {r.who && r.who.length ? <div className="who">{r.who.map((w) => <span key={w.k} title={words[w.k]}><Icon svg={icons[w.k]} />{w.text}</span>)}</div> : null}
      </div>
      {r.roles ? <span className="roles">{r.roles.map((x) => <span key={x.k} className={`role${x.on ? ' on' : ''}`} title={x.title}><Icon svg={icons[x.k]} /></span>)}</span> : null}
      {r.right ? (r.right.href ? <a href={r.right.href} target="_blank" rel="noopener">{r.right.text}</a> : <span className={`tag${r.right.live ? ' live' : ''}`}>{r.right.text}</span>) : null}
    </div>);
}

/** `blocks`: [{ note } | { legend: true } | { row: { t, s, who, roles, right } }]; `icons` and `words` by role key. */
export class ChipList extends React.Component {
  render() {
    const { blocks, icons, words } = this.props;
    return blocks.map((b, i) => (b.note !== undefined ? <div key={i} className="note">{b.note}</div>
      : b.legend ? <div key={i} className="legend">{ROLE_KEYS.map((k) => <span key={k}><Icon svg={icons[k]} />{words[k]}</span>)}</div>
        : <Row key={i} r={b.row} icons={icons} words={words} />));
  }
}
