// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEED PHRASE IN REACT (kanban #564, the Arena page): the modal the page's Settings opens - the 24 words numbered in a grid with why
// they matter, then "Verify seed phrase" from memory, one word at a time, 1 to 24, each out of four taken from this phrase (a wrong tap
// does not advance), then done. The backup is recorded by the page's own rule (`onRecord(words)` -> verifyAndRecord's { ok, why });
// `random(n)` is the page's crypto.getRandomValues. `onQuiz` keeps window.ARENA_VERIFY for the page's probes. A class component.
import React from 'react';

export class SeedModal extends React.Component {
  constructor(props) { super(props); this.state = { pane: 'words', at: 0, options: [], why: '' }; }
  optionsFor(at) {
    const { words, random } = this.props;
    const right = words[at], others = [...new Set(words.filter((w) => w !== right))], options = [right];
    while (options.length < 4 && others.length) options.push(others.splice(random(others.length), 1)[0]);
    for (let i = options.length - 1; i > 0; i--) { const j = random(i + 1); [options[i], options[j]] = [options[j], options[i]]; }
    if (this.props.onQuiz) this.props.onQuiz({ word: at + 1, options, right });
    return options;
  }
  start() { this.setState({ pane: 'verify', at: 0, why: '', options: this.optionsFor(0) }); }
  pick(w) {
    const { words } = this.props, { at } = this.state;
    if (w !== words[at]) return this.setState({ why: `Not word ${at + 1}. Try again.` });
    if (at + 1 < words.length) return this.setState({ at: at + 1, why: '', options: this.optionsFor(at + 1) });
    const said = this.props.onRecord(words);
    if (this.props.onQuiz) this.props.onQuiz({ done: !!said.ok });
    this.setState(said.ok ? { pane: 'done', why: '' } : { why: said.why });
  }
  render() {
    const { words, notReady, onClose } = this.props, { pane, at, options, why } = this.state;
    if (pane === 'verify') return (
      <div className="modal-box">
        <h3>Verify seed phrase</h3>
        <div>Word <span className="verify-n">{at + 1}</span> of {words.length}</div>
        <div className="opt-grid">{options.map((w) => <button key={w} type="button" data-word={w} onClick={() => this.pick(w)}>{w}</button>)}</div>
        <div className="why">{why}</div>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>);
    if (pane === 'done') return (
      <div className="modal-box"><div className="done">Seed phrase verified</div><button type="button" className="primary" onClick={onClose}>Done</button></div>);
    return (
      <div className="modal-box">
        <h3>Your seed phrase</h3>
        <div className="seed-why"><b>These 24 words are your wallet.</b> Your sats are kept only in this browser: if it is cleared, or this phone is lost or replaced, these words are the only way to get them back. Write them on paper, in order, and keep them offline. Never share them: whoever has them can take your sats.</div>
        <div className="seed-grid">{notReady || words.map((w, i) => <div key={i} className="seed-cell"><span className="n">{String(i + 1)}</span><span>{w}</span></div>)}</div>
        {notReady ? null : <button type="button" className="primary" onClick={() => this.start()}>Verify seed phrase</button>}
        <button type="button" onClick={onClose}>Close</button>
      </div>);
  }
}
