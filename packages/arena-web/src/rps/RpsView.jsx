// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROCK PAPER SCISSORS' TABLE, IN REACT (version 4's client): what the client's draw(state) built by hand - the last round's strip, the
// match score, who is at the table, the steps, the clock, the two seats, the moves, the verdict and how long the result takes -
// drawn from the same `state` its round logic computes (unchanged: the seating, the taps, the carried move, the switch before the
// close). The Three.js stage stays the client's own: its box is placed through a ref, its overlay (the clock and who is who) through a
// portal, and its icon layer joins the moves row as before. A tap marks its button at once and hands the move to the client's tap().
import React from 'react';
import { createPortal } from 'react-dom';

export const MOVES = Object.freeze([['Rock', '✊'], ['Paper', '✋'], ['Scissors', '✌️']]);
const R = 36, C = 2 * Math.PI * R;
export const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/** The verdict in the player's words: [tone, text]. */
export const VERDICT = Object.freeze({ win: ['win', 'You win 🏆'], loss: ['loss', 'You lose'], forfeit: ['loss', 'Not revealed · you lose'], draw: ['draw', 'Draw · stakes back'], void: ['draw', 'Not played · stake back'] });
/** The last round's strip: [tone, word]. */
export function lastWords(p) {
  if (p.phase === 'reveal') return ['draw', 'result coming…'];
  if (p.phase === 'alone') return ['draw', 'not played'];
  return ({ win: ['win', 'won'], loss: ['loss', 'lost'], forfeit: ['loss', 'lost'], draw: ['draw', 'draw'], void: ['draw', 'not played'] }[p.verdict] || ['draw', '']);
}
/** The opponent's name: the match's own (the seats sign it) when it is the same player, else the name the table's seats give. */
export function opponentOf(s) {
  const sb = s.scoreboard, names = s.here || [];
  const seen = names.find((o) => sb && o.key === sb.themKey) || names[0] || null;
  return { seen, name: seen ? (sb && seen.key === sb.themKey ? sb.themName : seen.name) : null, fallback: sb ? sb.themName : null };
}
export const STEP_AT = Object.freeze({ pick: 0, wait: 1, alone: 3, reveal: 2, result: 3 });

class Steps extends React.Component {
  render() {
    const at = this.props.at;
    return (
      <div className="steps">{[['✋', 'Pick'], ['⏳', 'Wait'], ['👁', 'Reveal'], ['🏁', 'Result']].map(([icon, name], i) => (
        <div key={name} className={`step${i < at ? ' done' : i === at ? ' now' : ''}`}><b>{i < at ? '✓' : icon}</b>{name}</div>))}</div>);
  }
}

/** The ring that empties towards entry close: only its arc and digits move, four times a second. */
export class Clock extends React.Component {
  constructor(props) { super(props); this.state = { now: props.now || Date.now() }; }
  componentDidMount() { this.timer = setInterval(() => this.setState({ now: Date.now() }), 250); }
  componentWillUnmount() { clearInterval(this.timer); }
  render() {
    const { closeMs, openMs } = this.props;
    const left = Math.max(0, closeMs - this.state.now), span = Math.max(1, closeMs - openMs);
    return (
      <div className="clock"><svg viewBox="0 0 84 84"><circle cx="42" cy="42" r={R} fill="none" stroke="#2a3242" strokeWidth="6" />
        <circle className="arc" cx="42" cy="42" r={R} fill="none" stroke="#f7931a" strokeWidth="6" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={String(C * (1 - Math.min(1, left / span)))} /></svg>
        <div className="t">{mmss(left)}</div></div>);
  }
}

/** The result not there yet: seconds since the moves closed, and the most it can still take. */
export class Due extends React.Component {
  constructor(props) { super(props); this.state = { now: props.now || Date.now() }; }
  componentDidMount() { this.timer = setInterval(() => this.setState({ now: Date.now() }), 1000); }
  componentWillUnmount() { clearInterval(this.timer); }
  render() {
    const { closeMs, endMs } = this.props; const now = this.state.now;
    const waited = Math.max(0, Math.floor((now - closeMs) / 1000)), left = endMs ? Math.ceil((endMs - now) / 1000) : null;
    return <div className="pick due">Result: waiting {waited} s{left === null ? '' : left > 0 ? ` · at most ${left} s more` : ` · past its ${Math.round((endMs - closeMs) / 1000)} s timeout, the seats are signing`}</div>;
  }
}

class Seat extends React.Component {
  render() { const { who, cls, face } = this.props; return <div className="seat"><div className={`slot ${cls}`}>{face}</div><div className="who">{who}</div></div>; }
}

/** The three moves. A tap marks its button and holds the others at once; the client's tap() takes it from there. */
export class Moves extends React.Component {
  constructor(props) { super(props); this.state = { tapped: null }; this.row = React.createRef(); }
  componentDidMount() { const { stage } = this.props; if (stage && this.row.current) stage.attachIcons(this.row.current, [...this.row.current.querySelectorAll('span.ic')]); }
  // THE CLIENT'S WORD WINS AT ITS NEXT DRAW: the mark only bridges the tap to the client's repaint - a refused tap is drawn with no move
  // chosen, and its buttons come back (the client said so: "That tap did not go in - tap again")
  componentDidUpdate(prev) { if (prev.drawn !== this.props.drawn && this.state.tapped !== null) this.setState({ tapped: null }); }
  tap(i) { if (this.state.tapped !== null || this.props.chosen !== null && this.props.chosen !== undefined) return; this.setState({ tapped: i }); this.props.onTap(i); }
  render() {
    const { stage, chosen } = this.props;
    const picked = chosen !== null && chosen !== undefined ? chosen : this.state.tapped;
    return (
      <div className="moves" ref={this.row}>{MOVES.map(([name, icon], i) => (
        <button key={name} type="button" disabled={picked !== null} className={picked === i ? 'chosen' : undefined} onClick={() => this.tap(i)}
          onPointerEnter={stage ? () => { stage.iconHover(i); if (picked === null) stage.preview(i); } : undefined}
          onPointerLeave={stage ? () => { stage.iconHover(null); if (picked === null) stage.preview(null); } : undefined}>
          {stage ? <span className="ic" /> : <span>{icon}</span>}{name}</button>))}</div>);
  }
}

/** The stage's own box, placed here; its overlay drawn into through a portal. */
class StageHost extends React.Component {
  constructor(props) { super(props); this.ref = React.createRef(); }
  componentDidMount() { this.place(); }
  componentDidUpdate() { this.place(); }
  place() { const { stage } = this.props; if (this.ref.current && stage.box.parentNode !== this.ref.current) this.ref.current.append(stage.box); }
  // NO BOX OF ITS OWN: the card is a flex column whose .stage grows (flex: 1) - a wrapper between them drew the stage at its minimum height
  render() { return <><div className="stage-host" style={{ display: 'contents' }} ref={this.ref} />{createPortal(this.props.children, this.props.stage.ov)}</>; }
}

export class RpsView extends React.Component {
  presence(s) {
    const moved = s.phase === 'pick' ? s.joined : s.them > 0;
    const names = s.here || [];
    const them = opponentOf(s).name;
    const what = s.phase === 'pick' ? (moved ? 'their move is in - pick yours' : 'pick your move') : (moved ? 'both moves are in - hidden until the round closes' : 'waiting for their move');
    return names.length || moved
      ? <div className="presence here"><span className="icon">⚔️</span><div><b>{them ? `You are playing against ${them}` : 'Opponent is here'}</b><small>{what}</small></div></div>
      : <div className="presence alone"><span className="icon">🙋</span><div><b>You are alone in this round</b><small>Waiting for other players<span className="dots"><i>.</i><i>.</i><i>.</i></span></small></div></div>;
  }
  table(s, stage) {
    if (stage) return null;
    const middle = s.phase === 'pick' || s.phase === 'wait' ? <div><Clock closeMs={s.closeMs} openMs={s.openMs} /></div> : <div><div className="vs">VS</div></div>;
    if (s.phase === 'pick') return <div className="table"><Seat who="you" cls="empty" face="?" />{middle}<Seat who={s.joined ? 'opponent in' : 'opponent'} cls={s.joined ? 'in' : 'empty'} face={s.joined ? '✓' : '?'} /></div>;
    if (s.phase === 'wait') return <div className="table"><Seat who={`you · ${MOVES[s.move][0]}`} cls="shown" face={MOVES[s.move][1]} />{middle}<Seat who={s.them ? 'opponent in' : 'waiting…'} cls={s.them ? 'in' : 'empty'} face={s.them ? '🔒' : '?'} /></div>;
    if (s.phase === 'alone') return <div className="table"><Seat who={`you · ${MOVES[s.move][0]}`} cls="shown" face={MOVES[s.move][1]} />{middle}<Seat who="nobody came" cls="empty" face="∅" /></div>;
    const win = s.verdict === 'win', loss = s.verdict === 'loss' || s.verdict === 'forfeit';
    return <div className="table"><Seat who="you" cls={`shown${win ? ' win' : loss ? ' loss' : ''}`} face={MOVES[s.move][1]} />{middle}
      <Seat who="them" cls={s.theirs === null ? 'empty' : `shown${loss ? ' win' : win ? ' loss' : ''}`} face={s.theirs === null ? '…' : MOVES[s.theirs][1]} /></div>;
  }
  card(s, stage) {
    const o = opponentOf(s);
    return (
      <div className="card">
        <Steps at={STEP_AT[s.phase]} />
        {stage ? <StageHost stage={stage}>
          {s.phase === 'pick' || s.phase === 'wait' ? <div className="top"><Clock closeMs={s.closeMs} openMs={s.openMs} /></div> : null}
          <div className="who me">You{s.phase === 'wait' || s.phase === 'reveal' ? ` · ${MOVES[s.move][0]}` : ''}</div>
          <div className="who them">{o.name || o.fallback || (s.phase === 'pick' && !s.joined && !(s.here || []).length ? 'waiting…' : 'opponent')}</div>
        </StageHost> : null}
        {this.table(s, stage)}
        {s.phase === 'pick' ? <>
          <div className="pick">{s.chosen !== null && s.chosen !== undefined ? `Your ${MOVES[s.chosen][0]} is going in…` : 'Pick - your opponent cannot see it until the round closes'}</div>
          <Moves key={s.id} stage={stage} chosen={s.chosen} drawn={this.props.drawn} onTap={(i) => this.props.onTap(s.id, i, s.closeMs)} /></> : null}
        {s.phase === 'alone' ? <div className="verdict draw">Not played · stake back</div> : null}
        {s.phase === 'reveal' || s.phase === 'result' ? <>
          {!s.verdict ? <Due key={s.id} closeMs={s.closeMs} endMs={s.endMs} /> : null}
          {s.verdict ? <div className={`verdict ${VERDICT[s.verdict][0]}`}>{VERDICT[s.verdict][1]}</div> : null}
          {s.verdict && s.score ? <div className="pick">score {s.score.me} : {s.score.them}{s.score.played ? '' : ' · match over'}</div> : null}</> : null}
      </div>);
  }
  render() {
    const { state: s, stage = null, stageFailed = false } = this.props;
    if (!s) return null;
    const loading = !stage && !stageFailed;
    const p = s.prev;
    return (
      <>
        {p && (p.phase === 'result' || p.phase === 'alone' || p.phase === 'reveal') ? (() => { const [tone, word] = lastWords(p); return (
          <div className={`last ${tone}`}><span>last round</span><b>{MOVES[p.move][1]}</b><i>vs</i><b>{p.theirs === null || p.theirs === undefined ? '∅' : MOVES[p.theirs][1]}</b><em>{word}</em></div>); })() : null}
        {s.scoreboard ? <div className="board"><span className="who">You</span><b>{s.scoreboard.me}</b><i>:</i><b>{s.scoreboard.them}</b><span className="who">{String(s.scoreboard.themName)}</span></div> : null}
        {s.phase === 'none' ? (loading ? <div className="card loading"><span className="spin" /></div>
          : stage ? <div className="card"><StageHost stage={stage} /><div className="pick">The next round opens in a moment.</div></div>
            : <div className="card none"><span className="big">⏳</span>The next round opens in a moment.</div>) : <>
          {s.phase === 'pick' || s.phase === 'wait' ? this.presence(s) : null}
          {loading ? <div className="card loading"><span className="spin" /></div> : this.card(s, stage)}</>}
      </>);
  }
}
