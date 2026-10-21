// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEASON BOARD'S ROWS IN REACT (kanban #564, the Arena page): one row per player as the page's seasonBoard drew them - rank, name,
// its badges (the page's badge book, `badgesOf(player)`), "you" or a Zap for another player, rounds / wins / best, net up or down - with a
// tapped badge's words under the row (the same badge again hides them). The page still asks the seats, polls every 30 s, keeps the badge
// book and its IntersectionObserver (each row carries data-player); this class component only draws `rows`.
import React from 'react';

class Badge extends React.Component {
  constructor(props) { super(props); this.state = { broken: false }; }
  render() {
    const { b, via, onTap } = this.props;
    const tap = (e) => { e.stopPropagation(); onTap(b.title); };
    if (b.image && !this.state.broken) return <button type="button" className="bi" title={b.title} aria-label={b.title} onClick={tap}><img alt="" width={18} height={18} src={via(b.image)} onError={() => this.setState({ broken: true })} /></button>;
    return <button type="button" className="bi g" title={b.title} aria-label={b.title} data-mark={b.glyph.mark} style={{ '--bc': b.glyph.colour }} onClick={tap} />;
  }
}

export class SeasonRows extends React.Component {
  constructor(props) { super(props); this.state = { said: {} }; }
  say(player, title) { this.setState((s) => ({ said: { ...s.said, [player]: s.said[player] === title ? '' : title } })); }
  render() {
    const { rows, badgesOf = () => null, via = (u) => u, onZap = null } = this.props;
    return rows.map((r, i) => {
      const merged = badgesOf(r.player);
      return (
        <li key={`${r.player}:${i}`} className={`row${r.mine ? ' mine' : ''}${i > 0 && r.rank !== rows[i - 1].rank + 1 ? ' gap' : ''}`} data-player={r.player}>
          <span className="rank">{String(r.rank)}</span>
          <div className="who">
            <div className="n">
              <span className="nm">{r.name}</span>
              <span className="bdg">{merged ? merged.badges.map((b) => <Badge key={b.title} b={b} via={via} onTap={(t) => this.say(r.player, t)} />) : null}</span>
              {r.mine ? <span className="you">you</span>
                : onZap && /^[0-9a-f]{64}$/.test(String(r.player)) ? <button type="button" className="zap" title={`Zap ${r.name}`} onClick={(e) => { e.stopPropagation(); onZap(r); }}>{'⚡ Zap'}</button> : null}
            </div>
            <div className="s">{[`${r.rounds} round${r.rounds === 1 ? '' : 's'}`, `${r.wins} win${r.wins === 1 ? '' : 's'}`, `best ${r.best}`].join(' · ')}</div>
            <div className="bt">{this.state.said[r.player] || ''}</div>
          </div>
          <b className={`net${r.sign > 0 ? ' up' : r.sign < 0 ? ' down' : ''}`} title={`${r.netMsat} msat`}>{r.net}</b>
        </li>);
    });
  }
}
