// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA'S GAMES SCREEN, IN REACT (kanban #564, the Arena page slice 1): the tiles of "Choose a game" - games first, then prediction
// markets; each its logo (its second route first, then the address as listed, then its initial), its type, its developer's description
// only once the page has checked the developer's signature, its nodes / players / rounds as chips that open their lists, its leaderboard,
// and a tip to the developer only to the address the developer signed. The same elements and classes as the page drew them, so the
// page's stylesheet (#arena-games ...) lays them out, both layouts included. Everything the page knows is handed in: `verifyInfo(g)` the
// page's signed-description check (game-info.js), `routed(url)` its second route, and what a tap does (`onChoose`, `onChip`,
// `onSeason`, `onTip`).
import React from 'react';

/** A game's kind: a market (attested), a head-to-head game (result type 3), or a game. */
export const kindOf = (g) => (g.attested ? 'market' : g.manifest && g.manifest.resultType === 3 ? 'head-to-head' : 'game');
export const BADGE = Object.freeze({ market: 'Prediction market', 'head-to-head': 'Head-to-head game', game: 'Game' });
/** Games first, then markets: [label, games] with any group left out that has none. */
export const groupsOf = (tiles) => [['Games', (tiles || []).filter((g) => !g.attested)], ['Prediction markets', (tiles || []).filter((g) => g.attested)]].filter(([, gs]) => gs.length);
/** A count as the chips write it: 999, 1.2k, 12k. */
export const countText = (n) => (n >= 1000 ? `${n >= 10000 ? Math.floor(n / 1000) : Math.floor(n / 100) / 10}k` : String(n));
const plural = (n, w) => `${w}${n === 1 ? '' : 's'}`;

const ICONS = {
  nodes: <><path d="M8 1.5 14 5v6l-6 3.5L2 11V5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><circle cx="8" cy="8" r="1.8" fill="currentColor" /></>,
  players: <><circle cx="8" cy="5" r="3" fill="currentColor" /><path d="M2 15c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5z" fill="currentColor" /></>,
  rounds: <><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M6.4 5.2v5.6L11 8z" fill="currentColor" /></>,
};
/** A tap on a chip, the leaderboard or a tip opens that - never the game the tile around it picks. */
const own = (fn) => ({
  onClick: (e) => { e.stopPropagation(); e.preventDefault(); fn(); },
  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); fn(); } },
});

class Chip extends React.Component {
  render() {
    const { n, word, shown = word, kind, idle, onOpen } = this.props;
    return (
      <span className={`chip${idle ? ' idle' : ''} opens`} title={`${n} ${word}`} aria-label={`${n} ${word}`} role="button" tabIndex={0} {...own(onOpen)}>
        <i /><svg className="ico" viewBox="0 0 16 16" aria-hidden="true">{ICONS[kind]}</svg>{countText(n)}<span className="word">{` ${shown}`}</span>
      </span>);
  }
}

export class GameTile extends React.Component {
  constructor(props) {
    super(props);
    const g = props.game, via = g.icon && props.routed ? props.routed(g.icon) : g.icon;
    this.state = { src: via || null, triedListed: !g.icon || via === g.icon, noIcon: !g.icon, info: props.info || null };
    this.iconFailed = this.iconFailed.bind(this);
  }
  async componentDidMount() {
    if (this.state.info || !this.props.verifyInfo) return;
    try { const info = await this.props.verifyInfo(this.props.game); if (info && !this.gone) this.setState({ info }); } catch { /* no description */ }
  }
  componentWillUnmount() { this.gone = true; }
  // its second route first, then the address as listed, then its initial
  iconFailed() { this.setState((s) => (s.triedListed ? { noIcon: true } : { src: this.props.game.icon, triedListed: true })); }
  signed(info) {
    const g = this.props.game;
    let host = null; try { host = info.website ? new URL(info.website).host : null; } catch { host = null; }
    return (
      <div className="signed">✓ signed by its developer
        {host ? <> · <a href={info.website} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{host}</a></> : null}
        {info.lightning && this.props.onTip ? <> · <button type="button" className="tip-dev" {...own(() => this.props.onTip(g, info))}>⚡ Tip the developer</button></> : null}
      </div>);
  }
  render() {
    const g = this.props.game; const kind = kindOf(g); const { src, noIcon, info } = this.state;
    const live = g.live || { rounds: 0, players: 0 }; const nodes = (g.nodes || []).length;
    const chip = (k) => () => this.props.onChip && this.props.onChip(g, k);
    return (
      <button type="button" className={`tile game ${kind === 'market' ? 'market' : 'play-game'}`} data-game={g.id} onClick={() => this.props.onChoose && this.props.onChoose(g)}>
        <span className="play">{kind === 'market' ? 'Trade' : 'Play'} →</span>
        <div className="head">
          <div className="logo">{!noIcon && src ? <img src={src} alt="" onError={this.iconFailed} /> : (g.title || '?').slice(0, 1)}</div>
          <div><div className="name">{g.title}</div><span className="badge">{BADGE[kind]}</span></div>
        </div>
        {info ? <div className="desc">{info.description}</div> : <div className="desc none">No signed description.</div>}
        {info ? this.signed(info) : <div className="signed" />}
        <div className="stats">
          <Chip n={nodes} word={plural(nodes, 'node')} kind="nodes" idle={false} onOpen={chip('nodes')} />
          <Chip n={live.players} word={plural(live.players, 'player')} kind="players" idle={!live.players} onOpen={chip('players')} />
          <Chip n={live.rounds} word={plural(live.rounds, 'live round')} shown={plural(live.rounds, 'round')} kind="rounds" idle={!live.rounds} onOpen={chip('rounds')} />
        </div>
        <span className="season-go" role="button" tabIndex={0} title={`Leaderboard: ${g.title || g.name} over the last days`} {...own(() => this.props.onSeason && this.props.onSeason(g))}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 2h7v3.5a3.5 3.5 0 0 1-7 0z" /><path d="M4.5 3.5H2.2a2.3 2.3 0 0 0 2.6 3M11.5 3.5h2.3a2.3 2.3 0 0 1-2.6 3M8 9v3M5.5 14h5" /></svg>Leaderboard
        </span>
        {g.known === false ? <div className="warn">Not pinned by this page: developer {String(g.devKey || '').slice(0, 16)}, manifest {String(g.id).slice(0, 16)}</div> : null}
      </button>);
  }
}

export class GameTiles extends React.Component {
  render() {
    const { tiles, ...rest } = this.props;
    return groupsOf(tiles).map(([label, games]) => (
      <section key={label} className="group">
        <h3>{label} · {games.length}</h3>
        <div className="grid">{games.map((g) => <GameTile key={g.id} game={g} info={(rest.infos || {})[g.id]} {...rest} />)}</div>
      </section>));
  }
}
