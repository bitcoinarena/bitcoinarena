// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE'S CONFIRMATIONS IN REACT (kanban #564, the Arena page): "Trust this federation?" (its id, its signed status, its guardians from
// the census), "Before you stake" (the round's warnings) and "Enter by swap" (the amount, the fee, the federations) - one frame, the
// words the page's gates make. The gate decides; this class component only asks, and answers once (`onAnswer(true | false)`).
import React from 'react';

export class ConfirmCard extends React.Component {
  constructor(props) { super(props); this.state = { answered: false }; }
  answer(v) { if (this.state.answered) return; this.setState({ answered: true }); this.props.onAnswer(v); }
  render() {
    const { title, sub, rows = [], guardians = null, guardiansEmpty = '', items = [], yes, no = 'Cancel' } = this.props;
    return (
      <div className="afc-box">
        <h2>{title}</h2>
        <p className="afc-sub">{sub}</p>
        {rows.map(([k, v]) => <div key={k} className="afc-row"><span>{k}</span><b>{v}</b></div>)}
        {guardians ? <div className="afc-guardians">{guardians.length ? guardians.map((g) => (
          <div key={g.nodeKey} className="afc-g"><b>{g.operator || '(no operator name)'}</b> · bond <span>{Number(g.bondSats).toLocaleString('en-US')}</span> sat<br /><code>{`node ${g.nodeKey}`}</code><br /><code>{g.endpoint || '(no endpoint)'}</code></div>))
          : guardiansEmpty}</div> : null}
        {items.length ? <ul>{items.map((t) => <li key={t}>{t}</li>)}</ul> : null}
        <div className="afc-buttons"><button type="button" className="primary" onClick={() => this.answer(true)}>{yes}</button><button type="button" onClick={() => this.answer(false)}>{no}</button></div>
      </div>);
  }
}
