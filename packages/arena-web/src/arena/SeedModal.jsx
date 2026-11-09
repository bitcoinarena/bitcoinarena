// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEED PHRASE IN REACT (kanban #564, the Arena page): the modal the page's Settings opens - the 24 words numbered in a grid with why
// they matter, then "Verify seed phrase" from memory: three of the 24 words at random, in order (kanban #1033, the owner 2026-11-02: "verify seed nur 3 der 24 Woerter"), each
// out of four taken from this phrase (a wrong tap does not advance), then done. The backup is recorded by the page's own rule (`onRecord(words)` -> verifyAndRecord's { ok, why });
// `random(n)` is the page's crypto.getRandomValues. `onQuiz` keeps window.ARENA_VERIFY for the page's probes. A class component.
import React from 'react';

/** How many of the 24 words the check asks for. */
export const SEED_CHECK_WORDS = 3;

export class SeedModal extends React.Component {
  constructor(props) { super(props); this.state = { pane: 'words', step: 0, picks: [], options: [], why: '' }; }
  /** Three positions of the phrase, lowest first. */
  draw() {
    const { words, random } = this.props;
    const left = words.map((_, i) => i), picks = [];
    while (picks.length < SEED_CHECK_WORDS && left.length) picks.push(left.splice(random(left.length), 1)[0]);
    return picks.sort((a, b) => a - b);
  }
  optionsFor(at) {
    const { words, random } = this.props;
    const right = words[at], others = [...new Set(words.filter((w) => w !== right))], options = [right];
    while (options.length < 4 && others.length) options.push(others.splice(random(others.length), 1)[0]);
    for (let i = options.length - 1; i > 0; i--) { const j = random(i + 1); [options[i], options[j]] = [options[j], options[i]]; }
    if (this.props.onQuiz) this.props.onQuiz({ word: at + 1, options, right });
    return options;
  }
  start() { const picks = this.draw(); this.setState({ pane: 'verify', step: 0, picks, why: '', options: this.optionsFor(picks[0]) }); }
  pick(w) {
    const { words } = this.props, { step, picks } = this.state, at = picks[step];
    if (w !== words[at]) return this.setState({ why: `Not word ${at + 1}. Try again.` });
    if (step + 1 < picks.length) return this.setState({ step: step + 1, why: '', options: this.optionsFor(picks[step + 1]) });
    const said = this.props.onRecord(words);
    if (this.props.onQuiz) this.props.onQuiz({ done: !!said.ok });
    this.setState(said.ok ? { pane: 'done', why: '' } : { why: said.why });
  }
  render() {
    const { words, notReady, onClose } = this.props, { pane, step, picks, options, why } = this.state, at = picks[step];
    if (pane === 'verify') return (
      <div className="modal-box">
        <h3>Verify seed phrase</h3>
        <div>Word <span className="verify-n">{at + 1}</span> of {words.length} ({step + 1} of {picks.length} to check)</div>
        <div className="opt-grid">{options.map((w) => <button key={w} type="button" data-word={w} onClick={() => this.pick(w)}>{w}</button>)}</div>
        <div className="why">{why}</div>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>);
    if (pane === 'done') return (
      <div className="modal-box"><div className="done">Seed phrase verified</div><button type="button" className="primary" onClick={onClose}>Done</button></div>);
    return (
      <div className="modal-box">
        <h3>Your seed phrase</h3>
        <div className="seed-why"><b>These 24 words are your wallet.</b> Write them down. Never share them.</div>
        <div className="seed-grid">{notReady || words.map((w, i) => <div key={i} className="seed-cell"><span className="n">{String(i + 1)}</span><span>{w}</span></div>)}</div>
        {notReady ? null : <button type="button" className="primary" onClick={() => this.start()}>Verify seed phrase</button>}
        <button type="button" onClick={onClose}>Close</button>
      </div>);
  }
}
